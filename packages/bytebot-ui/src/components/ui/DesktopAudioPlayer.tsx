"use client";

import React, { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "allyra-desktop-audio-enabled";

type DesktopAudioStatus = {
  source: string;
  hasSignal: boolean;
  peakDb: number | null;
  message: string;
};

export function DesktopAudioPlayer() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const statusTimerRef = useRef<number | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const skipAutoStartRef = useRef(false);

  const [enabled, setEnabled] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<DesktopAudioStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stopStream = React.useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (restartTimerRef.current) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }, []);

  const startStream = React.useCallback(
    async (streamUrl?: string) => {
      const audio = audioRef.current;
      if (!audio) return;

      const nextStreamUrl =
        streamUrl || `/api/proxy/desktop-audio/live?ts=${Date.now()}`;

      setIsStarting(true);
      setIsStreaming(false);
      setError(null);

      audio.volume = 1;
      audio.muted = false;
      audio.src = nextStreamUrl;
      audio.load();

      try {
        await audio.play();
        setError(null);
      } catch {
        setIsStreaming(false);
        setError("Click Audio once to allow browser playback.");
      } finally {
        setIsStarting(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "true") {
      setEnabled(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
  }, [enabled]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const scheduleRestart = () => {
      if (!enabled || restartTimerRef.current) return;
      restartTimerRef.current = window.setTimeout(() => {
        restartTimerRef.current = null;
        if (!enabled) return;
        void startStream(`/api/proxy/desktop-audio/live?ts=${Date.now()}`);
      }, 800);
    };

    const handlePlaying = () => {
      setError(null);
      setIsStreaming(true);
      if (restartTimerRef.current) {
        window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
    };
    const handleCanPlay = () => {
      setError(null);
    };
    const handleWaiting = () => {
      setIsStreaming(false);
    };
    const handleEnded = () => {
      setIsStreaming(false);
      scheduleRestart();
    };
    const handleError = () => {
      setIsStreaming(false);
      setError(
        "Desktop audio stream is connected, but the browser is not receiving playable audio yet.",
      );
      scheduleRestart();
    };

    audio.addEventListener("playing", handlePlaying);
    audio.addEventListener("canplay", handleCanPlay);
    audio.addEventListener("waiting", handleWaiting);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);

    return () => {
      audio.removeEventListener("playing", handlePlaying);
      audio.removeEventListener("canplay", handleCanPlay);
      audio.removeEventListener("waiting", handleWaiting);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      stopStream();
    };
  }, [enabled, startStream, stopStream]);

  useEffect(() => {
    if (!enabled) {
      stopStream();
      setError(null);
      setIsStarting(false);
      setIsStreaming(false);
      setStatus(null);
      return;
    }

    if (skipAutoStartRef.current) {
      skipAutoStartRef.current = false;
      return;
    }

    void startStream();
  }, [enabled, startStream, stopStream]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    let disposed = false;

    const pollStatus = async () => {
      try {
        const response = await fetch("/api/proxy/desktop-audio/status", {
          method: "GET",
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        const nextStatus = (await response.json()) as DesktopAudioStatus;
        if (!disposed) {
          setStatus(nextStatus);
        }
      } catch (pollError: unknown) {
        if (!disposed) {
          setStatus(null);
          setError(
            pollError instanceof Error
              ? `Unable to verify desktop audio signal: ${pollError.message}`
              : "Unable to verify desktop audio signal.",
          );
        }
      } finally {
        if (!disposed) {
          statusTimerRef.current = window.setTimeout(pollStatus, 1000);
        }
      }
    };

    void pollStatus();

    return () => {
      disposed = true;
      if (statusTimerRef.current) {
        window.clearTimeout(statusTimerRef.current);
        statusTimerRef.current = null;
      }
    };
  }, [enabled]);

  const statusLabel = (() => {
    if (!enabled) return null;
    if (isStarting) return "Starting";
    if (status?.hasSignal) return "Live";
    if (isStreaming) return "Silent";
    return "Waiting";
  })();

  const statusTitle =
    error ||
    status?.message ||
    (isStarting
      ? "Starting audio..."
      : isStreaming
        ? "Desktop stream connected, but no audible signal detected yet."
        : "Waiting for desktop media");

  const handleToggleAudio = () => {
    if (enabled) {
      setEnabled(false);
      return;
    }

    skipAutoStartRef.current = true;
    setEnabled(true);
    void startStream(`/api/proxy/desktop-audio/live?ts=${Date.now()}`);
  };

  return (
    <div className="flex items-center gap-1">
      <audio ref={audioRef} autoPlay playsInline preload="none" className="hidden" />
      <button
        type="button"
        onClick={handleToggleAudio}
        title={
          error ||
          (enabled
            ? "Mute the desktop audio stream in this browser"
            : "Enable the desktop audio stream in this browser")
        }
        className="border-bytebot-bronze-light-7 bg-bytebot-bronze-light-2/90 text-bytebot-bronze-light-12 hover:bg-bytebot-bronze-light-3 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium shadow-sm transition-colors"
      >
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            enabled
              ? status?.hasSignal
                ? "bg-emerald-500"
                : isStreaming
                  ? "bg-amber-400"
                  : "bg-bytebot-bronze-light-7"
              : "bg-bytebot-bronze-light-7"
          }`}
        />
        Audio
      </button>
      {enabled && statusLabel && (
        <span
          className="text-bytebot-bronze-light-11 max-w-28 truncate text-[11px]"
          title={statusTitle}
        >
          {statusLabel}
        </span>
      )}
    </div>
  );
}
