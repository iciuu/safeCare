"use client";

import { useEffect } from "react";

/**
 * 待复核队列的键盘导航：j/k 上下、Enter 保存、c 原样确认、i 忽略。
 * 在输入框里打字时不抢键，只有 Enter 会被当成「保存并继续」。
 */
export function ReviewShortcuts(): null {
  useEffect(() => {
    // -1 = 还没进过队列，第一次按 j 落到第一条
    let index = -1;

    const items = () => Array.from(document.querySelectorAll<HTMLElement>("[data-review-item]"));

    const focus = (next: number) => {
      const list = items();
      if (list.length === 0) return;
      index = Math.max(0, Math.min(list.length - 1, next));
      const item = list[index];
      item.scrollIntoView({ block: "center" });
      const field = item.querySelector<HTMLInputElement>("input[name='value']");
      field?.focus();
      field?.select();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const list = items();
      const current = list.findIndex((item) => item === target || item.contains(target));
      if (current >= 0) index = current;

      if (event.key === "Escape") {
        target?.blur();
        return;
      }

      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      const field = target as HTMLInputElement | null;
      // 输入框里没改过内容时，j/k 仍然用来翻条；改过就当成正常打字
      const untouched = !field || field.value === field.defaultValue;
      if (typing) {
        if (event.key === "Enter") {
          event.preventDefault();
          list[index]?.querySelector<HTMLButtonElement>("button[data-act='save']")?.click();
          return;
        }
        if (!untouched || (event.key !== "j" && event.key !== "k")) return;
      }

      const click = (act: string) =>
        list[index]?.querySelector<HTMLButtonElement>(`button[data-act='${act}']`)?.click();

      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        focus(index + 1);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        focus(index - 1);
      } else if (event.key === "c") {
        click("confirm");
      } else if (event.key === "i") {
        click("ignore");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return null;
}
