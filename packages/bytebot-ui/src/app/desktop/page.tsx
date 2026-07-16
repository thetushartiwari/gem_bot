"use client";

import React from "react";
import { Header } from "@/components/layout/Header";
import { DesktopContainer } from "@/components/ui/desktop-container";

export default function DesktopPage() {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[linear-gradient(180deg,_rgba(255,255,255,1)_0%,_rgba(250,246,255,1)_60%,_rgba(245,242,248,1)_100%)]">
      <Header />

      <main className="flex-1 overflow-hidden px-4 pb-5 pt-4">
        <div className="mx-auto flex h-full w-full max-w-[1320px] min-h-0 items-stretch justify-center">
          <div className="flex h-full min-h-0 w-full flex-col">
            <DesktopContainer
              viewOnly={false}
              status="live_view"
              className="h-full min-h-[560px]"
            >
              {/* No action buttons for desktop page */}
            </DesktopContainer>
          </div>
        </div>
      </main>
    </div>
  );
}
