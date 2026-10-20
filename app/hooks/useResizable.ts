"use client";

import { useState, useEffect, useCallback } from "react";

interface UseResizableOptions {
  initialWidth?: number; // 기본 50%
  minWidth?: number;     // 최소 비율 (기본 20%)
  maxWidth?: number;     // 최대 비율 (기본 80%)
  isEnabled?: boolean;
}

/**
 * 좌우 패널 너비 조절(드래그)을 관리하는 커스텀 훅
 */
export function useResizable({
  initialWidth = 50,
  minWidth = 20,
  maxWidth = 80,
  isEnabled = true,
}: UseResizableOptions = {}) {
  const [leftWidth, setLeftWidth] = useState(initialWidth);
  const [isDragging, setIsDragging] = useState(false);

  const startDragging = useCallback(() => {
    if (isEnabled) setIsDragging(true);
  }, [isEnabled]);

  const stopDragging = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (!isDragging || !isEnabled) return;

    const handleMove = (clientX: number) => {
      const newWidth = (clientX / window.innerWidth) * 100;
      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setLeftWidth(newWidth);
      }
    };

    const onMouseMove = (e: MouseEvent) => handleMove(e.clientX);
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        handleMove(e.touches[0].clientX);
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", stopDragging);
    window.addEventListener("touchmove", onTouchMove);
    window.addEventListener("touchend", stopDragging);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", stopDragging);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", stopDragging);
    };
  }, [isDragging, isEnabled, minWidth, maxWidth, stopDragging]);

  return {
    leftWidth,
    isDragging,
    startDragging,
    stopDragging,
    setLeftWidth,
  };
}
