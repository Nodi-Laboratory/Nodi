import type { ChatDoneEvent } from "@/lib/types";
import type { ItemData } from "./types";

type ClipEvent = NonNullable<ChatDoneEvent["clips"]>[number];

/** done 이벤트의 clip → ItemData.clip. page_url은 안정적이라 그대로 영속한다. */
export function clipToItemData(c: ClipEvent): ItemData {
  return {
    clip: {
      clipId: c.clip_id,
      title: c.title,
      startSec: c.start_sec,
      timelineLabel: c.timeline_label,
      pageUrl: c.page_url,
      videoTitle: c.video_title ?? "",
      score: c.score,
    },
  };
}
