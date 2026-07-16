"use client";

import React, { useEffect, useRef } from "react";
import { Header } from "@/components/layout/Header";
import { ChatContainer } from "@/components/messages/ChatContainer";
import { TaskUsagePanel } from "@/components/tasks/TaskUsagePanel";
import { DesktopContainer } from "@/components/ui/desktop-container";
import { useChatSession } from "@/hooks/useChatSession";
import { useScrollScreenshot } from "@/hooks/useScrollScreenshot";
import { useParams, useRouter } from "next/navigation";
import { Role, TaskStatus } from "@/types";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  MoreVerticalCircle01Icon,
  WavingHand01Icon,
} from "@hugeicons/core-free-icons";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { VirtualDesktopStatus } from "@/components/VirtualDesktopStatusHeader";

function normalizePlannerStepLabel(step?: string): string | null {
  const value = (step || "").trim();
  if (!value) {
    return null;
  }

  return value
    .replace(/^planner execution brief:\s*/i, "")
    .replace(/^recovery brief:\s*/i, "")
    .replace(/^step\s+\d+\s+of\s+\d+\.\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildRunningLabel(currentTask: ReturnType<typeof useChatSession>["currentTask"]): string {
  const security = currentTask?.result?.security;
  const execution = security?.execution;
  const media = security?.media;

  if (media?.transcriptionStatus === "transcribing" || media?.phase === "transcribing") {
    return "Allyra is running: generating the transcript...";
  }

  if (media?.phase === "summarizing") {
    return "Allyra is running: generating the summary...";
  }

  if (media?.recordingStartedAt && !media?.recordingStoppedAt) {
    return media?.kind === "meeting"
      ? "Allyra is running: recording and monitoring the meeting..."
      : "Allyra is running: recording and monitoring the media...";
  }

  if (execution?.watchdog?.activeRecovery) {
    return "Allyra is running: recovering from the current step...";
  }

  const stepLabel =
    normalizePlannerStepLabel(execution?.currentStep) ||
    normalizePlannerStepLabel(execution?.activeExecution?.description);
  if (stepLabel) {
    return `Allyra is running: ${stepLabel}`;
  }

  if (media?.phase === "monitoring" || media?.phase === "quiet_monitoring") {
    return media?.kind === "meeting"
      ? "Allyra is running: monitoring the meeting..."
      : "Allyra is running: monitoring playback...";
  }

  return "Allyra is running...";
}

export default function TaskPage() {
  const usageToggleKey = "allyra:show-task-usage";
  const params = useParams();
  const router = useRouter();
  const taskId = params.id as string;

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const {
    messages,
    groupedMessages,
    currentTask,
    taskStatus,
    control,
    input,
    setInput,
    isLoading,
    isLoadingSession,
    isLoadingMoreMessages,
    hasMoreMessages,
    loadMoreMessages,
    handleAddMessage,
    handleTakeOverTask,
    handleResumeTask,
    handleCancelTask,
    currentTaskId,
  } = useChatSession({ initialTaskId: taskId });
  const runningLabel = buildRunningLabel(currentTask);
  const [showUsage, setShowUsage] = React.useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    setShowUsage(window.localStorage.getItem(usageToggleKey) === "true");
  }, [usageToggleKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(usageToggleKey, showUsage ? "true" : "false");
  }, [showUsage, usageToggleKey]);

  // Determine if task is inactive (show screenshot) or active (show VNC)
  function isTaskInactive(): boolean {
    return (
      taskStatus === TaskStatus.COMPLETED ||
      taskStatus === TaskStatus.FAILED ||
      taskStatus === TaskStatus.CANCELLED
    );
  }

  // Determine if user can take control
  function canTakeOver(): boolean {
    return control === Role.ASSISTANT && taskStatus === TaskStatus.RUNNING;
  }

  // Determine if user has control or is in takeover mode
  function hasUserControl(): boolean {
    return (
      control === Role.USER &&
      (taskStatus === TaskStatus.RUNNING ||
        taskStatus === TaskStatus.NEEDS_HELP ||
        taskStatus === TaskStatus.NEEDS_REVIEW)
    );
  }

  // Determine if task can be cancelled
  function canCancel(): boolean {
    return (
      taskStatus === TaskStatus.RUNNING ||
      taskStatus === TaskStatus.NEEDS_HELP ||
      taskStatus === TaskStatus.NEEDS_REVIEW
    );
  }

  // Determine VNC mode - interactive when user has control, view-only otherwise
  function vncViewOnly(): boolean {
    return !hasUserControl();
  }

  // Use scroll screenshot hook for inactive tasks
  const { currentScreenshot } = useScrollScreenshot({
    messages,
    scrollContainerRef: chatContainerRef,
  });

  // For inactive tasks, auto-load all messages for proper screenshot navigation
  useEffect(() => {
    if (isTaskInactive() && hasMoreMessages && !isLoadingMoreMessages) {
      loadMoreMessages();
    }
  }, [
    isTaskInactive(),
    hasMoreMessages,
    isLoadingMoreMessages,
    loadMoreMessages,
  ]);

  // Map each message ID to its flat index for screenshot scroll logic
  const messageIdToIndex = React.useMemo(() => {
    const map: Record<string, number> = {};
    messages.forEach((msg, idx) => {
      map[msg.id] = idx;
    });
    return map;
  }, [messages]);

  // Redirect if task ID doesn't match current task
  useEffect(() => {
    if (currentTaskId && currentTaskId !== taskId) {
      router.push(`/tasks/${currentTaskId}`);
    }
  }, [currentTaskId, taskId, router]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />

      <main className="m-2 flex-1 overflow-hidden px-2 py-4 min-h-0">
        <div className="grid h-full min-h-0 grid-cols-7 gap-4">
          {/* Main container */}
          <div className="col-span-4 flex min-h-0">
            <DesktopContainer
              screenshot={isTaskInactive() ? currentScreenshot : null}
              viewOnly={vncViewOnly()}
              status={
                (() => {
                  if (
                    taskStatus === TaskStatus.RUNNING &&
                    control === Role.USER
                  )
                    return "user_control";
                  if (taskStatus === TaskStatus.RUNNING) return "running";
                  if (
                    taskStatus === TaskStatus.NEEDS_HELP ||
                    taskStatus === TaskStatus.NEEDS_REVIEW
                  )
                    return "needs_attention";
                  if (taskStatus === TaskStatus.FAILED) return "failed";
                  if (taskStatus === TaskStatus.CANCELLED) return "canceled";
                  if (taskStatus === TaskStatus.COMPLETED) return "completed";
                  // You may want to add a scheduled state if you have that info
                  return "pending";
                })() as VirtualDesktopStatus
              }
            >
              {canTakeOver() && (
                <Button
                  onClick={handleTakeOverTask}
                  variant="default"
                  size="sm"
                  icon={
                    <HugeiconsIcon
                      icon={WavingHand01Icon}
                      className="h-5 w-5"
                    />
                  }
                >
                  Take Over
                </Button>
              )}
              {hasUserControl() && (
                <Button onClick={handleResumeTask} variant="default" size="sm">
                  Proceed
                </Button>
              )}
              {canCancel() && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon">
                      <HugeiconsIcon
                        icon={MoreVerticalCircle01Icon}
                        className="text-bytebot-bronze-light-11 h-5 w-5"
                      />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={handleCancelTask}
                      className="text-red-600 focus:bg-red-50"
                    >
                      Cancel
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </DesktopContainer>
          </div>

          {/* Chat Area */}
          <div className="col-span-3 flex h-full min-h-0 flex-col">
            <TaskUsagePanel
              usage={currentTask?.result?.usage}
              enabled={showUsage}
              onEnabledChange={setShowUsage}
            />
            {/* Messages scrollable area */}
            <div
              ref={chatContainerRef}
              className="hide-scrollbar min-h-0 flex-1 overflow-scroll px-4"
            >
              <ChatContainer
                scrollRef={chatContainerRef}
                messageIdToIndex={messageIdToIndex}
                taskId={taskId}
                input={input}
                setInput={setInput}
                isLoading={isLoading}
                handleAddMessage={handleAddMessage}
                groupedMessages={groupedMessages}
                taskStatus={taskStatus}
                control={control}
                isLoadingSession={isLoadingSession}
                isLoadingMoreMessages={isLoadingMoreMessages}
                hasMoreMessages={hasMoreMessages}
                loadMoreMessages={loadMoreMessages}
                runningLabel={runningLabel}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
