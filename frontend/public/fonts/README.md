# 캔버스 손글씨 폰트 (D164)

`nanum-yageun-*.woff2` 셋은 **나눔손글씨 야근하는 김주임**을 캔버스 전용으로
쪼갠 것이다. 원본 TTF는 커밋하지 않는다(5.2MB).

## 왜 세 조각인가

woff2 한 덩어리는 2.9MB다. 캔버스를 여는 학생이 매번 그걸 받는 대신,
브라우저가 **실제로 그린 글자가 든 조각만** 받도록 unicode-range로 나눴다.

| 파일 | 담긴 글자 | 크기 | 언제 받나 |
|---|---|---|---|
| `nanum-yageun-latin.woff2` | 한글 아닌 것 160자 | 27KB | 거의 항상 |
| `nanum-yageun-ks.woff2` | KS X 1001 완성형 한글 2,350자 | 497KB | 거의 항상 |
| `nanum-yageun-ext.woff2` | 나머지 음절 8,822자 | 2,325KB | 희귀 음절이 나올 때만 |

교실 한국어는 사실상 KS X 1001 안에서 끝나므로 보통 524KB만 받는다.

## 다시 만들려면

```sh
uv run --no-project --with "fonttools[woff]" python scripts/build-hand-font.py \
    "나눔손글씨 야근하는 김주임.ttf" public/fonts \
    src/components/canvas2/hand-font.css
```

`hand-font.css`는 **생성물이다** — 직접 고치면 다음 빌드에 덮어써진다.
unicode-range는 파일에 실제로 든 글자만 적는다(cmap과 교집합). 없는 글자를
적으면 브라우저가 그 조각을 다 받고 나서야 폴백으로 떨어진다.

## 라이선스

폰트 파일이 스스로 밝히는 것은 저작권 표시뿐이다:

```
Copyright © 2019 NAVER Corporation. All rights reserved.
Font created by CLOVA AI OCR Team.
fsType = 8 (Editable embedding — 임베딩 허용)
```

이름 테이블에 **라이선스 문구(nameID 13)·URL(nameID 14)이 없다.** 네이버가
나눔손글씨 시리즈를 배포하는 조건(SIL Open Font License 1.1로 알려져 있다)은
배포 페이지 https://hangeul.naver.com/font 에서 확인하고, 공식 라이선스 파일을
이 디렉터리에 함께 두는 것이 안전하다 — OFL은 사본과 함께 라이선스 전문을
배포할 것을 요구한다.
