"""이메일 주소 타입 (D104-4).

pydantic의 `EmailStr`을 그대로 쓰지 않는 이유: 기본 설정이 `.test`·`.local`
같은 **특수용도 TLD를 거부**한다. 그러면 로컬 개발·테스트에서 쓰는
`teacher@nodi.local` 같은 주소로 가입이 안 된다(실측: 422).

문법 검증은 그대로 하되(email_validator) 특수용도 도메인만 허용한다. 배달
가능성(MX 조회)은 확인하지 않는다 — 가입 경로에 DNS 왕복을 넣지 않는다.
"""

from __future__ import annotations

from typing import Annotated

import email_validator
from email_validator import EmailNotValidError, validate_email
from pydantic import AfterValidator

# `.local`을 특수용도 차단 목록에서 뺀다.
#
# email_validator는 mDNS 예약어라는 이유로 `.local`을 거부하고, 그건
# `test_environment=True`로도 풀리지 않는다(그 옵션은 .test/.invalid/localhost
# 만 허용). 이 프로젝트는 로컬 계정 규약으로 `@nodi.local`을 쓰므로 가입 자체가
# 막힌다(실측 422).
#
# 나머지 예약 도메인(.invalid·.onion·.arpa 등)은 그대로 막아 둔다 — 전부 푸는
# 대신 실제로 쓰는 하나만 연다.
if "local" in email_validator.SPECIAL_USE_DOMAIN_NAMES:
    email_validator.SPECIAL_USE_DOMAIN_NAMES.remove("local")


def _normalize(value: str) -> str:
    try:
        info = validate_email(
            value,
            check_deliverability=False,  # DNS 왕복 금지
            test_environment=True,       # .test/localhost 허용
        )
    except EmailNotValidError as exc:
        raise ValueError(f"올바른 이메일 주소가 아닙니다: {exc}") from exc
    # 정규화된 형태로 저장한다 — DB는 citext라 대소문자는 이미 무시하지만,
    # 유니코드 정규화까지 맞춰 두면 중복 계정이 생기지 않는다.
    return info.normalized.lower()


EmailAddress = Annotated[str, AfterValidator(_normalize)]
