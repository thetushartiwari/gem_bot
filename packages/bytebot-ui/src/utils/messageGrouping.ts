import {
  Message,
  GroupedMessages,
  Role,
} from "@/types";
import {
  MessageContentBlock,
  MessageContentType,
  isComputerToolUseContentBlock,
  isToolResultContentBlock,
  isUserActionContentBlock,
} from "@bytebot/shared";

export function normalizeMessageForChat(message: Message): Message {
  const processedMessage: Message = { ...message };
  const contentBlocks = (message.content || []) as MessageContentBlock[];

  if (message.role === Role.USER) {
    if (contentBlocks.every((block) => isToolResultContentBlock(block))) {
      processedMessage.role = Role.ASSISTANT;
    } else if (contentBlocks.every((block) => isUserActionContentBlock(block))) {
      processedMessage.content = contentBlocks
        .flatMap((block) => block.content)
        .filter((block) => isComputerToolUseContentBlock(block));
      processedMessage.role = Role.ASSISTANT;
      processedMessage.take_over = true;
    }
  }

  return processedMessage;
}

export function groupMessagesForChat(messages: Message[]): GroupedMessages[] {
  const groupedConversation: GroupedMessages[] = [];
  let currentGroup: GroupedMessages | null = null;

  for (const rawMessage of messages) {
    const message = normalizeMessageForChat(rawMessage);
    const role = message.role;
    const isTakeOver = message.take_over || false;
    const forceStandalone = shouldKeepStandaloneAssistantMessage(message);

    if (
      forceStandalone ||
      !currentGroup ||
      currentGroup.role !== role ||
      currentGroup.take_over !== isTakeOver
    ) {
      if (currentGroup) {
        groupedConversation.push(currentGroup);
      }

      const nextGroup: GroupedMessages = {
        role,
        messages: [message],
        take_over: isTakeOver,
      };
      currentGroup = nextGroup;
      if (forceStandalone) {
        groupedConversation.push(nextGroup);
        currentGroup = null;
      }
    } else {
      currentGroup.messages.push(message);
    }
  }

  if (currentGroup) {
    groupedConversation.push(currentGroup);
  }

  return groupedConversation;
}

function shouldKeepStandaloneAssistantMessage(message: Message): boolean {
  if (message.role !== Role.ASSISTANT) {
    return false;
  }

  const firstText = (message.content || []).find(
    (block) => block.type === MessageContentType.Text,
  ) as { text?: string } | undefined;
  const normalized = (firstText?.text || "").trim();
  if (!normalized) {
    return false;
  }

  return /^(Plan:|Planner:|Verification:|Progress:|Completed:|Watchdog:|Task result ready:|I hit a blocker:|I need your attention:)/i.test(
    normalized,
  );
}

export function mergeMessagesChronologically(
  existingMessages: Message[],
  incomingMessages: Message[],
): Message[] {
  const byId = new Map<string, Message>();

  for (const message of existingMessages) {
    byId.set(message.id, message);
  }

  for (const message of incomingMessages) {
    byId.set(message.id, message);
  }

  return Array.from(byId.values()).sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    if (leftTime === rightTime) {
      return left.id.localeCompare(right.id);
    }
    return leftTime - rightTime;
  });
}
