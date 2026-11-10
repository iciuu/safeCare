"use client";

import { useEffect, useState } from "react";

/**
 * 两步确认的提交按钮：第一次点只是「上膛」，再点一次才真的提交。
 * 不用 window.confirm —— 原生弹窗会卡住整页脚本，在本地单机场景也不好看。
 */
export function ConfirmButton({
  children,
  confirmLabel = "确认删除？",
  className,
  confirmClassName,
  timeoutMs = 5000,
}: {
  children: React.ReactNode;
  confirmLabel?: string;
  className?: string;
  confirmClassName?: string;
  timeoutMs?: number;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), timeoutMs);
    return () => clearTimeout(timer);
  }, [armed, timeoutMs]);

  return (
    <button
      type="button"
      aria-label={armed ? confirmLabel : undefined}
      onClick={(event) => {
        if (armed) {
          setArmed(false);
          event.currentTarget.form?.requestSubmit();
          return;
        }
        setArmed(true);
      }}
      className={armed ? (confirmClassName ?? className) : className}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
