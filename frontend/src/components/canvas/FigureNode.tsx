"use client";

// FigureNode — 교과서 figure 리프 노드(캔버스 절대배치, .nodi-spawn 등장). D87.
// VideoNode의 라이트박스 구조 이식(iframe→img). figure.url은 signed(만료 有):
//   url==="" → 스켈레톤(재수화 비동기 채움 대기), <img> 로드 실패(만료) 시
//   getFigure로 **1회만** 재발급 후 src 교체(무한 재시도 금지, 재실패 시 스켈레톤 유지).
// 오버레이는 createPortal로 document.body에 렌더 — NoteCanvas의 transform(scale)
//   평면 밖으로 빼야 position:fixed가 뷰포트 기준으로 동작(VideoNode 관례 동일).

import { memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getFigure } from "@/lib/api";
import type { CanvasLeafNode } from "@/lib/concept/types";
import styles from "./FigureNode.module.css";

function FigureNode({ node }: { node: CanvasLeafNode }) {
  const figure = node.figure;
  const [open, setOpen] = useState(false);
  // 만료 대비 재발급 URL(성공 시 원본 src를 덮어씀) + 1회 재시도 가드.
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // 1회 재시도 가드(무한 재시도 금지). state — 렌더 중 리셋 가능(ref는 렌더 중 변경 불가).
  const [retried, setRetried] = useState(false);

  // figure.url이 바뀌면(재수화가 url=""→signed 채움, 또는 대표 figure 교체)
  // 재발급 상태를 리셋한다 — 렌더 중 이전값 비교(React 공식 "prop 변경 시 state
  // 조정" 패턴, 이펙트/추가 렌더 없이 즉시 반영). freshUrl 자체 갱신은 figure.url을
  // 바꾸지 않으므로 재발급 URL은 그대로 유지된다.
  const [seenUrl, setSeenUrl] = useState(figure?.url);
  if (figure && figure.url !== seenUrl) {
    setSeenUrl(figure.url);
    setFreshUrl(null);
    setFailed(false);
    setRetried(false);
  }

  // 라이트박스 Esc 닫기(훅은 조기 반환 이전에 무조건 호출).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!figure) return null;

  const src = freshUrl ?? figure.url;
  const hasImage = !!src && !failed;
  const label = figure.caption || "교과서 도판";
  const pageLabel = typeof figure.page === "number" ? `p.${figure.page}` : null;

  // <img> 로드 실패: 만료로 보고 getFigure로 1회만 재발급. 재실패 시 스켈레톤 유지.
  const onImgError = async () => {
    if (retried) {
      setFailed(true);
      return;
    }
    setRetried(true);
    try {
      const fresh = await getFigure(figure.figureId);
      if (fresh.url) setFreshUrl(fresh.url);
      else setFailed(true);
    } catch {
      setFailed(true);
    }
  };

  const body = (
    <>
      <span className={styles.label}>교과서 도판</span>
      <span className={styles.thumb}>
        {hasImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className={styles.img}
            src={src}
            alt={label}
            loading="lazy"
            draggable={false}
            onError={onImgError}
          />
        ) : (
          <span className={styles.skeleton} aria-hidden="true" />
        )}
      </span>
      <span className={styles.caption}>
        {pageLabel ? <span className={styles.page}>{pageLabel}</span> : null}
        <span className={styles.captionText}>{figure.caption}</span>
      </span>
    </>
  );

  return (
    <div
      className={`${styles.node} nodi-spawn`}
      style={{ left: node.x, top: node.y }}
      data-testid="figure-node"
      data-leaf-id={node.id}
    >
      {/* 이미지가 있으면 클릭 시 라이트박스. 스켈레톤 상태는 클릭 불가(div). */}
      {hasImage ? (
        <button
          className={styles.body}
          type="button"
          onClick={() => setOpen(true)}
          data-no-pan
        >
          {body}
        </button>
      ) : (
        <div className={styles.body}>{body}</div>
      )}

      {open && hasImage && typeof document !== "undefined"
        ? createPortal(
            <div
              className={styles.overlay}
              role="dialog"
              aria-modal="true"
              aria-label={label}
              data-testid="figure-lightbox"
              onClick={() => setOpen(false)}
            >
              <div
                className={styles.dialog}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className={styles.close}
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="닫기"
                  data-testid="figure-close"
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                  >
                    <path
                      d="M4 4 L12 12 M12 4 L4 12"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className={styles.lightboxImg}
                  src={src}
                  alt={label}
                  onError={onImgError}
                />
                {figure.caption ? (
                  <p className={styles.lightboxCaption}>
                    {pageLabel ? (
                      <span className={styles.page}>{pageLabel} </span>
                    ) : null}
                    {figure.caption}
                  </p>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export default memo(FigureNode);
