import React, { useRef, useEffect, useState } from "react";
import { VncViewer } from "@/components/vnc/VncViewer";
import { ScreenshotViewer } from "@/components/screenshot/ScreenshotViewer";
import { ScreenshotData } from "@/utils/screenshotUtils";
import {
  VirtualDesktopStatusHeader,
  VirtualDesktopStatus,
} from "@/components/VirtualDesktopStatusHeader";
import { DesktopAudioPlayer } from "@/components/ui/DesktopAudioPlayer";

interface DesktopContainerProps {
  children?: React.ReactNode;
  screenshot?: ScreenshotData | null;
  viewOnly?: boolean;
  className?: string;
  status?: VirtualDesktopStatus;
}

export const DesktopContainer: React.FC<DesktopContainerProps> = ({
  children,
  screenshot,
  viewOnly = false,
  className = "",
  status = "running",
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [isMounted, setIsMounted] = useState(false);

  // Set isMounted to true after component mounts
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Calculate the container size on mount and window resize
  useEffect(() => {
    if (!isMounted) return;

    const updateSize = () => {
      if (!containerRef.current) return;

      const parentWidth =
        containerRef.current.parentElement?.offsetWidth ||
        containerRef.current.offsetWidth;
      const parentHeight =
        containerRef.current.parentElement?.offsetHeight ||
        containerRef.current.offsetHeight;

      // Calculate the maximum size while maintaining 1280:960 aspect ratio
      let width, height;
      const aspectRatio = 1280 / 960;

      if (parentWidth / parentHeight > aspectRatio) {
        // Width is the limiting factor
        height = parentHeight;
        width = height * aspectRatio;
      } else {
        // Height is the limiting factor
        width = parentWidth;
        height = width / aspectRatio;
      }

      // Cap at maximum dimensions
      width = Math.min(width, 1280);
      height = Math.min(height, 960);

      setContainerSize({ width, height });
    };

    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, [isMounted]);

  return (
    <div
      className={`border-bytebot-bronze-light-6 flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[26px] border bg-white/92 shadow-[0_24px_60px_rgba(60,12,94,0.10)] backdrop-blur ${className}`}
    >
      <div className="border-bytebot-bronze-light-6 bg-gradient-to-r from-white via-bytebot-bronze-light-1 to-fuchsia-50/70 flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex items-center gap-2">
          <VirtualDesktopStatusHeader status={status} />
        </div>

        <div className="shrink-0 flex items-center gap-2">{children}</div>
      </div>

      <div
        ref={containerRef}
        className="relative flex flex-1 min-h-0 items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(246,244,255,0.95),_rgba(255,255,255,0.92)_45%,_rgba(247,245,249,0.96)_100%)] p-4"
      >
        <div className="absolute right-4 top-4 z-10">
          <DesktopAudioPlayer />
        </div>
        <div
          style={{
            width: `${containerSize.width}px`,
            height: `${containerSize.height}px`,
            maxWidth: "100%",
            maxHeight: "100%",
          }}
          className="overflow-hidden rounded-2xl border border-bytebot-bronze-light-6 bg-white shadow-[0_12px_35px_rgba(32,20,49,0.12)]"
        >
          {screenshot ? (
            <ScreenshotViewer
              screenshot={screenshot}
              className="h-full w-full"
            />
          ) : (
            <VncViewer viewOnly={viewOnly} />
          )}
        </div>
      </div>
    </div>
  );
};
