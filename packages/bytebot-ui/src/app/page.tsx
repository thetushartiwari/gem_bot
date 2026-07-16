"use client";

import React, { useState, useEffect, useRef } from "react";
import Image from "next/image";
import { Header } from "@/components/layout/Header";
import { ChatInput } from "@/components/messages/ChatInput";
import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteSavedBrowserSession,
  fetchSavedBrowserSessions,
  saveGlobalCredential,
  startTask,
} from "@/utils/taskUtils";
import { Model, SavedBrowserSession } from "@/types";
import { TaskList } from "@/components/tasks/TaskList";

interface StockPhotoProps {
  src: string;
  alt?: string;
}

const StockPhoto: React.FC<StockPhotoProps> = ({
  src,
  alt = "Decorative image",
}) => {
  return (
    <div className="h-full w-full overflow-hidden rounded-lg bg-white">
      <div className="relative h-full w-full">
        <Image src={src} alt={alt} fill className="object-cover" priority />
      </div>
    </div>
  );
};

interface FileWithBase64 {
  name: string;
  base64: string;
  type: string;
  size: number;
}

export default function Home() {
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<Model | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<FileWithBase64[]>([]);
  const [secureSite, setSecureSite] = useState("");
  const [secureUsername, setSecureUsername] = useState("");
  const [securePassword, setSecurePassword] = useState("");
  const [secureModeEnabled, setSecureModeEnabled] = useState(false);
  const [isSavingCredential, setIsSavingCredential] = useState(false);
  const [credentialSaveNotice, setCredentialSaveNotice] = useState("");
  const [savedSessions, setSavedSessions] = useState<SavedBrowserSession[]>([]);
  const [deletingSessionLabel, setDeletingSessionLabel] = useState("");
  const router = useRouter();
  const [activePopoverIndex, setActivePopoverIndex] = useState<number | null>(
    null,
  );
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/tasks/models")
      .then((res) => res.json())
      .then((data) => {
        setModels(data);
        if (data.length > 0) setSelectedModel(data[0]);
      })
      .catch((err) => console.error("Failed to load models", err));

    fetchSavedBrowserSessions()
      .then((data) => setSavedSessions(data))
      .catch((err) => console.error("Failed to load saved browser sessions", err));
  }, []);

  // Close popover when clicking outside or pressing ESC
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        buttonsRef.current &&
        !buttonsRef.current.contains(event.target as Node)
      ) {
        setActivePopoverIndex(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActivePopoverIndex(null);
      }
    };

    if (activePopoverIndex !== null) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [activePopoverIndex]);

  const handleSend = async () => {
    if (!input.trim()) return;

    setIsLoading(true);

    try {
      if (!selectedModel) throw new Error("No model selected");
      // Send request to start a new task
      const taskData: {
        description: string;
        model: Model;
        files?: FileWithBase64[];
        secureCredential?: {
          site: string;
          username?: string;
          password?: string;
          mode: "use_once" | "save_for_later";
          sessionLabel?: string;
        };
      } = {
        description: input,
        model: selectedModel,
      };

      // Include files if any are uploaded
      if (uploadedFiles.length > 0) {
        taskData.files = uploadedFiles;
      }

      if (secureModeEnabled && (secureUsername || securePassword)) {
        taskData.secureCredential = {
          site: secureSite || "secure-login",
          ...(secureUsername ? { username: secureUsername } : {}),
          ...(securePassword ? { password: securePassword } : {}),
          mode: "use_once",
        };
      }

      const task = await startTask(taskData);

      if (task && task.id) {
        setSecureSite("");
        setSecureUsername("");
        setSecurePassword("");
        setCredentialSaveNotice("");
        setSecureModeEnabled(false);
        // Redirect to the task page
        router.push(`/tasks/${task.id}`);
      } else {
        // Handle error
        console.error("Failed to create task");
      }
    } catch (error) {
      console.error("Error sending message:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileUpload = (files: FileWithBase64[]) => {
    setUploadedFiles(files);
  };

  const refreshSavedSessions = async () => {
    const sessions = await fetchSavedBrowserSessions();
    setSavedSessions(sessions);
  };

  const handleSaveCredential = async () => {
    const normalizedSite = secureSite.trim();
    const normalizedUsername = secureUsername.trim();
    const normalizedPassword = securePassword.trim();

    if (!normalizedSite || (!normalizedUsername && !normalizedPassword)) {
      setCredentialSaveNotice(
        "Enter the site plus at least a username or password before saving.",
      );
      return;
    }

    setIsSavingCredential(true);
    setCredentialSaveNotice("");

    try {
      const saved = await saveGlobalCredential({
        site: normalizedSite,
        ...(normalizedUsername ? { username: normalizedUsername } : {}),
        ...(normalizedPassword ? { password: normalizedPassword } : {}),
        mode: "save_for_later",
        sessionLabel: normalizedSite,
      });

      if (saved) {
        await refreshSavedSessions();
        setCredentialSaveNotice(`Saved ${normalizedSite} for future tasks.`);
      } else {
        setCredentialSaveNotice("Could not save those credentials right now.");
      }
    } finally {
      setIsSavingCredential(false);
    }
  };

  const handleDeleteSavedSession = async (label: string) => {
    setDeletingSessionLabel(label);
    try {
      const deleted = await deleteSavedBrowserSession(label);
      if (deleted) {
        await refreshSavedSessions();
      }
    } finally {
      setDeletingSessionLabel("");
    }
  };

  const renderSecurityPanel = () => (
    <div className="mt-3 rounded-xl border border-stone-200 bg-stone-50 p-3">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Saved Auth Bundles
          </label>
          <p className="text-xs text-stone-500">
            Allyra now uses saved browser sessions and encrypted credentials automatically when a task clearly matches them. Keep them here mainly to review or remove them.
          </p>
          {savedSessions.length > 0 && (
            <div className="flex flex-col gap-2 rounded-md border border-stone-200 bg-white p-2">
              {savedSessions.map((session) => (
                <div
                  key={session.label}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-stone-900">
                      {session.label}
                    </p>
                    <p className="truncate text-xs text-stone-500">
                      {session.site ||
                        (session.browser ? "Saved Brave session" : "Saved credentials")}
                      {session.hasCredential === false ? " · needs re-save to add credentials" : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteSavedSession(session.label)}
                    disabled={deletingSessionLabel === session.label}
                    className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {deletingSessionLabel === session.label ? "Removing..." : "Remove"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between rounded-md bg-white px-3 py-2">
          <div>
            <p className="text-sm font-medium text-stone-900">Secure Login Details</p>
            <p className="text-xs text-stone-500">
              Use these for the current task, or save them once for future tasks.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setSecureModeEnabled((prev) => !prev)}
            className="rounded-md border border-stone-300 px-3 py-1 text-xs font-medium text-stone-700"
          >
            {secureModeEnabled ? "Hide" : "Add"}
          </button>
        </div>

        {secureModeEnabled && (
          <div className="grid gap-2 md:grid-cols-2">
            <input
              value={secureSite}
              onChange={(e) => setSecureSite(e.target.value)}
              placeholder="Site or app"
              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"
            />
            <input
              value={secureUsername}
              onChange={(e) => setSecureUsername(e.target.value)}
              placeholder="Email or username"
              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"
            />
            <input
              type="password"
              value={securePassword}
              onChange={(e) => setSecurePassword(e.target.value)}
              placeholder="Password"
              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"
            />
            <div className="col-span-full flex items-center justify-between gap-3 rounded-md border border-stone-200 bg-stone-100 px-3 py-2">
              <p className="text-xs text-stone-600">
                Save these credentials once to reuse them automatically in future tasks.
              </p>
              <button
                type="button"
                onClick={handleSaveCredential}
                disabled={isSavingCredential}
                className="rounded-md bg-bytebot-bronze-dark-7 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-bytebot-bronze-dark-6 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSavingCredential ? "Saving..." : "Save"}
              </button>
            </div>
            {credentialSaveNotice && (
              <p className="col-span-full text-xs text-stone-600">
                {credentialSaveNotice}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />

      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Desktop grid layout (50/50 split) - only visible on large screens */}
        <div className="hidden h-full p-8 lg:grid lg:grid-cols-2 lg:gap-8">
          {/* Main content area */}
          <div className="flex flex-col items-center overflow-y-auto">
            <div className="flex w-full max-w-xl flex-col items-center">
              <div className="mb-6 flex w-full flex-col items-start justify-start">
                <h1 className="text-bytebot-bronze-light-12 mb-1 text-2xl">
                  What can I help you get done?
                </h1>
              </div>

              <div className="bg-bytebot-bronze-light-a3 mb-10 w-full rounded-2xl p-1">
                <div className="border-bytebot-bronze-light-a3 bg-white rounded-xl border p-3">
                  <ChatInput
                    input={input}
                    isLoading={isLoading}
                    onInputChange={setInput}
                    onSend={handleSend}
                    onFileUpload={handleFileUpload}
                    minLines={3}
                  />
                  {renderSecurityPanel()}
                  <div className="mt-2">
                    <Select
                      value={selectedModel?.name}
                      onValueChange={(val) =>
                        setSelectedModel(
                          models.find((m) => m.name === val) || null,
                        )
                      }
                    >
                      <SelectTrigger className="w-auto">
                        <SelectValue placeholder="Select a model" />
                      </SelectTrigger>
                      <SelectContent>
                        {models.map((m) => (
                          <SelectItem key={m.name} value={m.name}>
                            {m.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              <TaskList
                className="w-full"
                title="Latest Tasks"
                description="You'll see tasks that are completed, scheduled, or require your attention."
              />
            </div>
          </div>

          {/* Stock photo area - centered in its grid cell */}
          <div className="flex items-center justify-center px-6 pt-6">
            <div className="aspect-square h-full w-full max-w-md xl:max-w-2xl">
              <StockPhoto src="/canvas.avif" alt="Allyra canvas" />
            </div>
          </div>
        </div>

        {/* Mobile layout - only visible on small/medium screens */}
        <div className="flex h-full flex-col lg:hidden">
          <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 pt-10">
            <div className="flex w-full max-w-xl flex-col items-center pb-10">
              <div className="mb-6 flex w-full flex-col items-start justify-start">
                <h1 className="text-bytebot-bronze-light-12 mb-1 text-2xl">
                  What can I help you get done?
                </h1>
              </div>

              <div className="bg-bytebot-bronze-light-a3 mb-10 w-full rounded-2xl p-1">
                <div className="border-bytebot-bronze-light-a3 bg-white rounded-xl border p-3">
                  <ChatInput
                    input={input}
                    isLoading={isLoading}
                    onInputChange={setInput}
                    onSend={handleSend}
                    onFileUpload={handleFileUpload}
                    minLines={3}
                  />
                  {renderSecurityPanel()}
                  <div className="mt-2">
                    <Select
                      value={selectedModel?.name}
                      onValueChange={(val) =>
                        setSelectedModel(
                          models.find((m) => m.name === val) || null,
                        )
                      }
                    >
                      <SelectTrigger className="w-auto">
                        <SelectValue placeholder="Select a model" />
                      </SelectTrigger>
                      <SelectContent>
                        {models.map((m) => (
                          <SelectItem key={m.name} value={m.name}>
                            {m.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              <TaskList
                className="w-full"
                title="Latest Tasks"
                description="You'll see tasks that are completed, scheduled, or require your attention."
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
