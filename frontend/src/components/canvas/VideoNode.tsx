"use client";

// VideoNode — EBS 추천 영상 리프 노드(캔버스 절대배치, .nodi-spawn 등장).
// Nodi-figma EbsCard 이식: 재생은 카드 인라인 iframe(높이 변동 → 겹침) 대신
//   화면 중앙 라이트박스 오버레이(백드롭 + 16:9 iframe + 닫기).
// 오버레이는 createPortal로 document.body에 렌더 — NoteCanvas의 transform(scale)
//   평면 밖으로 빼야 position:fixed가 뷰포트 기준으로 동작.

import { memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { CanvasLeafNode } from "@/lib/concept/types";
import styles from "./VideoNode.module.css";

// YouTube videoId 형식(11자 [A-Za-z0-9_-]) 방어 검증.
const YT_ID = /^[\w-]{11}$/;

function VideoNode({ node }: { node: CanvasLeafNode }) {
  const [playing, setPlaying] = useState(false);
  const video = node.video;

  // 라이트박스 열림 중 Esc 닫기(훅은 조기 반환 이전에 무조건 호출).
  useEffect(() => {
    if (!playing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlaying(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing]);

  if (!video?.videoId) return null;

  const title = video.title || "EBS 추천 영상";
  const canEmbed = YT_ID.test(video.videoId);
  const open = playing && canEmbed;

  const inner = (
    <>
      <span className={styles.thumb}>
        {video.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className={styles.thumbImg}
            src={video.thumb}
            alt={title}
            loading="lazy"
          />
        ) : (
          <span className={styles.thumbFallback} />
        )}
        {canEmbed ? (
          <span className={styles.play} aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 14 14">
              <path d="M4 3 L11 7 L4 11 Z" fill="var(--yellow, #FFC526)" />
            </svg>
          </span>
        ) : null}
      </span>
      <span className={styles.info}>
        <span className={styles.label}>EBS 클립뱅크 추천</span>
        <span className={styles.title}>{title}</span>
        <span className={styles.meta}>노디가 골라줬어요</span>
      </span>
    </>
  );

  return (
    <div
      className={`${styles.node} nodi-spawn`}
      style={{ left: node.x, top: node.y }}
      data-testid="video-node"
      data-leaf-id={node.id}
    >
      {/* 카드 본문은 항상 썸네일(높이 불변). 재생은 오버레이가 담당. */}
      {canEmbed ? (
        <button
          className={styles.body}
          type="button"
          onClick={() => setPlaying(true)}
          data-no-pan
        >
          {inner}
        </button>
      ) : (
        <div className={styles.body}>{inner}</div>
      )}

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className={styles.overlay}
              role="dialog"
              aria-modal="true"
              aria-label={title}
              data-testid="video-lightbox"
              onClick={() => setPlaying(false)}
            >
              <div
                className={styles.dialog}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className={styles.close}
                  type="button"
                  onClick={() => setPlaying(false)}
                  aria-label="닫기"
                  data-testid="video-close"
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
                <div className={styles.player}>
                  <iframe
                    className={styles.iframe}
                    src={`https://www.youtube.com/embed/${video.videoId}?autoplay=1`}
                    title={title}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export default memo(VideoNode);
