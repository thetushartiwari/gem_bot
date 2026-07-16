import React, { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  TaskDaily01Icon,
  Home01Icon,
  ComputerIcon,
} from "@hugeicons/core-free-icons";
import { usePathname } from "next/navigation";

export function Header() {
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();

  // After mounting, we can safely show the theme-dependent content
  useEffect(() => {
    setMounted(true);
  }, []);

  // Function to determine if a link is active
  const isActive = (path: string) => {
    if (path === "/") {
      return pathname === "/";
    }
    return pathname?.startsWith(path);
  };

  // Get classes for navigation links based on active state
  const getLinkClasses = (path: string) => {
    const baseClasses =
      "flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium transition-all";
    const activeClasses =
      "border-fuchsia-300 bg-gradient-to-r from-fuchsia-500 to-violet-500 text-white shadow-sm shadow-fuchsia-200";
    const inactiveClasses =
      "border-transparent text-bytebot-bronze-dark-9 hover:border-bytebot-bronze-light-6 hover:bg-white hover:text-bytebot-bronze-light-12";

    return `${baseClasses} ${isActive(path) ? activeClasses : inactiveClasses}`;
  };

  return (
    <header className="bg-background/95 flex items-center justify-between border-b px-5 py-4 backdrop-blur">
      <div className="flex items-center gap-6">
        {/* Logo without link */}
        <div>
          {mounted ? (
            <Image
              src="/allyra.png"
              alt="Allyra Logo"
              width={100}
              height={30}
              className="h-8 w-auto"
            />
          ) : (
            <div className="h-8 w-[110px]" />
          )}
        </div>
        <div className="border-bytebot-bronze-dark-11 h-5 border border-l-[0.5px]"></div>
        <div className="flex items-center gap-2 rounded-full border border-white/70 bg-white/70 p-1 shadow-sm">
          <Link href="/" className={getLinkClasses("/")}>
            <HugeiconsIcon icon={Home01Icon} className="h-4 w-4" />
            <span>Home</span>
          </Link>
          <Link href="/tasks" className={getLinkClasses("/tasks")}>
            <HugeiconsIcon icon={TaskDaily01Icon} className="h-4 w-4" />
            <span>Tasks</span>
          </Link>
          <Link href="/desktop" className={getLinkClasses("/desktop")}>
            <HugeiconsIcon icon={ComputerIcon} className="h-4 w-4" />
            <span>Desktop</span>
          </Link>
        </div>
      </div>
      <div className="flex items-center gap-3"></div>
    </header>
  );
}
