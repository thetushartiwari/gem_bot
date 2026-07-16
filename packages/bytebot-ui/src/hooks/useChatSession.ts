import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Message, Role, TaskStatus, Task, GroupedMessages } from "@/types";
import {
  addMessage,
  fetchTaskRawMessages,
  fetchTaskById,
  takeOverTask,
  resumeTask,
  cancelTask,
} from "@/utils/taskUtils";
import { MessageContentType } from "@bytebot/shared";
import { useWebSocket } from "./useWebSocket";
import {
  groupMessagesForChat,
  mergeMessagesChronologically,
} from "@/utils/messageGrouping";

interface UseChatSessionProps {
  initialTaskId?: string;
}

const TASK_MESSAGE_PAGE_SIZE = 50;

export function useChatSession({ initialTaskId }: UseChatSessionProps = {}) {
  const [taskStatus, setTaskStatus] = useState<TaskStatus>(TaskStatus.PENDING);
  const [control, setControl] = useState<Role>(Role.ASSISTANT);
  const [currentTask, setCurrentTask] = useState<Task | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(
    initialTaskId || null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(true);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMoreMessages, setHasMoreMessages] = useState(true);

  const processedMessageIds = useRef<Set<string>>(new Set());
  const groupedMessages: GroupedMessages[] = useMemo(
    () => groupMessagesForChat(messages),
    [messages],
  );

  // WebSocket event handlers
  const handleTaskUpdate = useCallback(
    (task: Task) => {
      if (task.id === currentTaskId) {
        setCurrentTask(task);
        setTaskStatus(task.status);
        setControl(task.control);
      }
    },
    [currentTaskId],
  );

  const handleNewMessage = useCallback(
    (message: Message) => {
      // Only add message if it's not already processed and belongs to current task
      if (
        !processedMessageIds.current.has(message.id) &&
        message.taskId === currentTaskId
      ) {
        console.log("Adding new message from WebSocket:", message);
        processedMessageIds.current.add(message.id);
        setMessages((prev) => mergeMessagesChronologically(prev, [message]));
      }
    },
    [currentTaskId],
  );

  const handleTaskCreated = useCallback((task: Task) => {
    console.log("New task created:", task);
  }, []);

  const handleTaskDeleted = useCallback(
    (taskId: string) => {
      if (taskId === currentTaskId) {
        console.log("Current task was deleted");
        setCurrentTask(null);
        setCurrentTaskId(null);
        setMessages([]);
        processedMessageIds.current = new Set();
      }
    },
    [currentTaskId],
  );

  // Initialize WebSocket connection
  const { joinTask, leaveTask } = useWebSocket({
    onTaskUpdate: handleTaskUpdate,
    onNewMessage: handleNewMessage,
    onTaskCreated: handleTaskCreated,
    onTaskDeleted: handleTaskDeleted,
  });

  // Load more messages function for infinite scroll
  const loadMoreMessages = useCallback(async () => {
    if (!currentTaskId || isLoadingMoreMessages || !hasMoreMessages) {
      console.log("loadMoreMessages early return");
      return;
    }

    setIsLoadingMoreMessages(true);
    try {
      const nextPage = currentPage + 1;
      const olderMessages = await fetchTaskRawMessages(currentTaskId, {
        limit: TASK_MESSAGE_PAGE_SIZE,
        page: nextPage,
      });

      if (olderMessages.length === 0) {
        setHasMoreMessages(false);
      } else {
        const uniqueMessages = olderMessages.filter(
          (msg) => !processedMessageIds.current.has(msg.id),
        );

        if (uniqueMessages.length > 0) {
          uniqueMessages.forEach((msg: Message) => {
            processedMessageIds.current.add(msg.id);
          });

          setMessages((prev) => mergeMessagesChronologically(prev, uniqueMessages));
        }

        setCurrentPage(nextPage);

        if (olderMessages.length < TASK_MESSAGE_PAGE_SIZE) {
          setHasMoreMessages(false);
        }
      }
    } catch (error) {
      console.error("Error loading more messages:", error);
    } finally {
      setIsLoadingMoreMessages(false);
    }
  }, [currentTaskId, currentPage, isLoadingMoreMessages, hasMoreMessages]);

  // Load task ID from URL parameter or fetch the latest task on initial render
  useEffect(() => {
    const loadSession = async () => {
      setIsLoadingSession(true);
      try {
        if (initialTaskId) {
          processedMessageIds.current = new Set();
          setMessages([]);
          setCurrentPage(1);
          setHasMoreMessages(true);

          // If we have an initial task ID (from URL), fetch that specific task
          console.log(`Fetching specific task: ${initialTaskId}`);
          const task = await fetchTaskById(initialTaskId);
          const messages = await fetchTaskRawMessages(initialTaskId, {
            limit: TASK_MESSAGE_PAGE_SIZE,
            page: 1,
          });

          if (task) {
            console.log(`Found task: ${task.id}`);
            setCurrentTask(task);
            setCurrentTaskId(task.id);
            setTaskStatus(task.status); // Set the task status when loading
            setControl(task.control);

            // If the task has messages, add them to the messages state for compatibility
            if (messages && messages.length > 0) {
              messages.forEach((msg: Message) => {
                processedMessageIds.current.add(msg.id);
              });

              setMessages(mergeMessagesChronologically([], messages));
              setCurrentPage(1);

              if (messages.length < TASK_MESSAGE_PAGE_SIZE) {
                setHasMoreMessages(false);
              } else {
                setHasMoreMessages(true);
              }
            } else {
              setCurrentPage(1);
              setHasMoreMessages(false);
            }
          } else {
            console.log(`Task with ID ${initialTaskId} not found`);
          }
        }
      } catch (error) {
        console.error("Error loading session:", error);
      } finally {
        setIsLoadingSession(false);
      }
    };

    loadSession();
  }, [initialTaskId]);

  // Join/leave WebSocket task rooms when task ID changes
  useEffect(() => {
    if (currentTaskId) {
      console.log(`Joining WebSocket room for task: ${currentTaskId}`);
      joinTask(currentTaskId);
    } else {
      console.log("Leaving WebSocket task room");
      leaveTask();
    }
  }, [currentTaskId, joinTask, leaveTask]);

  const handleAddMessage = async () => {
    if (!input.trim()) return;

    setIsLoading(true);

    try {
      const message = input;
      setInput("");

      // Send request to start a new task or continue existing task
      const response = await addMessage(currentTaskId!, message);

      if (!response) {
        // Add error message to chat
        const errorMessage: Message = {
          id: Date.now().toString(),
          content: [
            {
              type: MessageContentType.Text,
              text: "Sorry, there was an error processing your request. Please try again.",
            },
          ],
          role: Role.ASSISTANT,
        };

        processedMessageIds.current.add(errorMessage.id);
        setMessages((prev) => mergeMessagesChronologically(prev, [errorMessage]));
      } else {
        setCurrentTask(response);
        setTaskStatus(response.status);
        setControl(response.control);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleTakeOverTask = async () => {
    if (!currentTaskId) return;

    try {
      const updatedTask = await takeOverTask(currentTaskId);
      if (updatedTask) {
        setCurrentTask(updatedTask);
        setControl(updatedTask.control);
      }
    } catch (error) {
      console.error("Error taking over task:", error);
    }
  };

  const handleResumeTask = async () => {
    if (!currentTaskId) return;

    try {
      const updatedTask = await resumeTask(currentTaskId);
      if (updatedTask) {
        setCurrentTask(updatedTask);
        setControl(updatedTask.control);
      }
    } catch (error) {
      console.error("Error resuming task:", error);
    }
  };

  const handleCancelTask = async () => {
    if (!currentTaskId) return;

    try {
      const updatedTask = await cancelTask(currentTaskId);
      if (updatedTask) {
        setCurrentTask(updatedTask);
        setTaskStatus(updatedTask.status);
        setControl(updatedTask.control);
      }
    } catch (error) {
      console.error("Error cancelling task:", error);
    }
  };

  return {
    messages,
    groupedMessages,
    currentTask,
    taskStatus,
    control,
    input,
    setInput,
    currentTaskId,
    isLoading,
    isLoadingSession,
    isLoadingMoreMessages,
    hasMoreMessages,
    loadMoreMessages,
    handleAddMessage,
    handleTakeOverTask,
    handleResumeTask,
    handleCancelTask,
  };
}
