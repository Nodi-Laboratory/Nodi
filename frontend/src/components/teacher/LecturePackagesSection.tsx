"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PlaySquare } from "lucide-react";
import { toggleClassLecturePackage } from "@/lib/api";
import type { ClassLecturePackage } from "@/lib/api";
import {
  classLecturePackagesKey,
  useClassLecturePackages,
} from "@/lib/queries";

/**
 * 강의 추천 패키지 섹션(D149): admin이 만든 강의 패키지를 이 학급에 켜고 끈다.
 * 켜면 학생 질의 시 그 패키지의 강의 클립을 근거로 추천할 수 있다.
 */
export function LecturePackagesSection({ classId }: { classId: string }) {
  const { data: packages, isLoading } = useClassLecturePackages(classId);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <PlaySquare size={15} className="shrink-0 text-fg-muted" />
        <h2 className="text-sm font-semibold text-fg">강의 추천 패키지</h2>
      </div>
      <p className="text-xs text-fg-muted">
        켜 둔 패키지의 강의 클립을 학생 질문에 맞춰 추천합니다.
      </p>

      {isLoading ? (
        <p className="text-sm text-fg-muted">패키지 불러오는 중…</p>
      ) : !packages || packages.length === 0 ? (
        <p className="rounded-lg border border-dashed border-accent-border/50 p-6 text-center text-sm text-fg-muted">
          관리자가 만든 강의 패키지가 없습니다.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {packages.map((pkg) => (
            <PackageItem key={pkg.id} pkg={pkg} classId={classId} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PackageItem({
  pkg,
  classId,
}: {
  pkg: ClassLecturePackage;
  classId: string;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async () => {
    const next = !pkg.enabled;
    setError(null);
    setPending(true);
    try {
      await toggleClassLecturePackage(classId, pkg.id, next);
      await queryClient.invalidateQueries({
        queryKey: classLecturePackagesKey(classId),
      });
    } catch (e) {
      setError(`설정 실패: ${(e as Error).message}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <li className="rounded-lg border border-accent-border/30 bg-bg-elevated p-3">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-sm text-fg">
          {pkg.grade} · {pkg.subject} · {pkg.title}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={pkg.enabled}
          aria-label={`${pkg.title} 추천 ${pkg.enabled ? "끄기" : "켜기"}`}
          onClick={handleToggle}
          disabled={pending}
          className="shrink-0 disabled:opacity-50"
        >
          <span
            className={`relative block h-5 w-9 rounded-full transition-colors ${
              pkg.enabled ? "bg-accent-deep" : "bg-accent-soft"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                pkg.enabled ? "translate-x-[18px]" : "translate-x-[2px]"
              }`}
            />
          </span>
        </button>
      </div>
      {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}
    </li>
  );
}
