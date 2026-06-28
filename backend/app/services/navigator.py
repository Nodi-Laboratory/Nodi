"""Navigator node gate + INLINE generation (Stage 2 Part B).

DESIGN NOTE — inline, not background:
  architecture §7 envisions navigator creation as a background job (jobs queue +
  apscheduler). That worker runs without a user JWT and therefore needs a
  service_role key, which is currently empty. So Stage 2 generates navigator
  nodes INLINE inside the user's chat request (gated), using the caller's JWT so
  RLS still applies. The real background queue is deferred to Stage 3.

Gate (only fires when ALL hold):
  - the current branch (head's ancestor chain, real nodes only) has >= K nodes;
  - those branch nodes share >= C concept tags (a tag on >= 2 branch nodes);
  - the head has no pending (unused) is_navigator child yet
    (approximates the "period / cost" throttle — avoids piling up suggestions).

On fire: generate N related questions via the generate_navigator_questions
skill (ReAct skeleton) and insert N waiting nodes
(is_navigator=true, navigator_question=q, parent_id=head, question/answer null).
"""

from __future__ import annotations

import logging
from typing import Any

from ..ai.react import Budget, ReActRunner
from ..config import get_settings
from .supabase_client import UserClient

logger = logging.getLogger("nodi.navigator")
settings = get_settings()


def _ancestor_chain(
    nodes: list[dict[str, Any]], head_id: str
) -> list[dict[str, Any]]:
    by_id = {n["id"]: n for n in nodes}
    chain: list[dict[str, Any]] = []
    cursor = by_id.get(head_id)
    guard = 0
    while cursor is not None and guard < 10000:
        chain.append(cursor)
        cursor = by_id.get(cursor.get("parent_id"))
        guard += 1
    chain.reverse()
    return chain


def _branch_has_pending_navigator(
    nodes: list[dict[str, Any]], chain: list[dict[str, Any]]
) -> bool:
    """True if ANY node on the current branch (head->root) still has an unused
    is_navigator child.

    This is the cost/period throttle: while an un-consumed navigator bundle is
    floating anywhere on the branch, no new bundle is generated until the user
    clicks one (consumed = DELETEd) or the branch is otherwise cleared. Caps the
    branch to at most one live navigator bundle, so the gate cannot fire on
    (nearly) every assistant turn once the branch matured.
    """
    branch_ids = {n["id"] for n in chain}
    return any(
        n.get("is_navigator") and n.get("parent_id") in branch_ids
        for n in nodes
    )


def _clamp_int(value: Any, default: int, lo: int, hi: int) -> int:
    """Per-request override (D47), clamped to an admin-safe range, else default."""
    if value is None:
        return default
    try:
        v = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def _period_elapsed(real_branch_len: int, k: int, period: int) -> bool:
    """Eligible only at branch real-node counts K, K+period, K+2*period, ...

    period <= 1 means "every eligible turn" (subject to the bundle throttle).
    """
    if period <= 1:
        return True
    return (real_branch_len - k) % period == 0


async def _branch_common_tags(
    client: UserClient, node_ids: list[str]
) -> list[str]:
    """Tag names attached to >= 2 of the given nodes (shared across branch)."""
    if not node_ids:
        return []
    rows = await client.select(
        "node_tags",
        {
            "node_id": f"in.({','.join(node_ids)})",
            "select": "node_id,tags(name)",
        },
    )
    counts: dict[str, set[str]] = {}
    for r in rows:
        tag = r.get("tags") or {}
        name = tag.get("name") if isinstance(tag, dict) else None
        if not name:
            continue
        counts.setdefault(name, set()).add(r.get("node_id"))
    return [name for name, ids in counts.items() if len(ids) >= 2]


async def maybe_generate(
    client: UserClient,
    owner_id: str,
    session_id: str,
    head_id: str,
    nodes: list[dict[str, Any]],
    override: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Evaluate the gate and, if it fires, create navigator nodes.

    `nodes` must already include the just-created head node. Returns the created
    navigator nodes ({id, parent_id, navigator_question, navigator_meta}) or [].

    `override` (D47, per-request user settings) is clamped to an admin-safe range
    and takes precedence over config: ``enabled`` False disables generation for
    this turn; ``count`` (1..5), ``gate_k`` (1..10), ``period`` (1..20).
    """
    override = override or {}
    # D47 enabled gate: an explicit user opt-out disables navigator this turn.
    if override.get("enabled") is False:
        return []

    k = _clamp_int(override.get("gate_k"), settings.navigator_gate_k, 1, 10)
    period = _clamp_int(override.get("period"), settings.navigator_period, 1, 20)
    count = _clamp_int(
        override.get("count"), settings.navigator_question_count, 1, 5
    )
    c = settings.navigator_gate_c

    chain = _ancestor_chain(nodes, head_id)
    real_branch = [n for n in chain if not n.get("is_navigator")]
    if len(real_branch) < k:
        return []
    # Throttle 1 (core): only one live (unused) navigator bundle per branch.
    if _branch_has_pending_navigator(nodes, chain):
        return []
    # Throttle 2 (period): space firings out along the branch. Once a bundle is
    # consumed, do not re-fire until the branch has grown to the next eligible
    # length (K, K+period, K+2*period, ...). Deleted bundles leave no trace, so
    # we key off the branch real-node count rather than "nodes since last fire".
    if not _period_elapsed(len(real_branch), k, period):
        return []

    common_tags = await _branch_common_tags(
        client, [n["id"] for n in real_branch]
    )
    if len(common_tags) < c:
        return []

    branch_qa = [
        (n.get("question") or "", n.get("answer") or "") for n in real_branch
    ]

    runner = ReActRunner(
        client,
        owner_id,
        kind="navigator",
        session_id=session_id,
        budget=Budget(settings.react_max_steps, settings.react_max_tokens),
    )
    obs = await runner.run_skill(
        "generate_navigator_questions",
        thought="Branch matured (>=K nodes, shared tags); suggest follow-ups.",
        branch=branch_qa,
        tags=common_tags,
        count=count,
    )
    # D40: the skill returns {question, rationale} objects (rationale <=40 chars,
    # "what this question reveals"). Normalize defensively — older/degenerate
    # outputs may yield bare strings; treat those as rationale-less.
    items: list[dict[str, str]] = []
    for it in obs.get("questions") or []:
        if isinstance(it, dict):
            q = (it.get("question") or "").strip()
            r = (it.get("rationale") or "").strip()
        elif isinstance(it, str):
            q, r = it.strip(), ""
        else:
            continue
        if q:
            items.append({"question": q, "rationale": r[:40]})
        if len(items) >= count:
            break
    if not items:
        return []

    created: list[dict[str, Any]] = []
    for item in items:
        meta = {"rationale": item["rationale"]} if item["rationale"] else {}
        node = await client.insert(
            "nodes",
            {
                "session_id": session_id,
                "parent_id": head_id,
                "is_navigator": True,
                "navigator_question": item["question"],
                "navigator_meta": meta,  # D40: rationale for the click popup
            },
        )
        created.append(
            {
                "id": node["id"],
                "parent_id": node.get("parent_id"),
                "navigator_question": node.get("navigator_question"),
                "navigator_meta": node.get("navigator_meta") or meta,
            }
        )
    return created
