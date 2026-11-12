import { type ChatFileAttachment, type ChatImageAttachment, type ChatMessage } from "../../types";
import type { ComposerContextRecord, KnownComposerContextRecord } from "@t3tools/contracts";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import {
  assistantCitationsToPlainText,
  collectAssistantCitations,
} from "@t3tools/shared/assistantCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { asKnownContextRecord, resolveUserMessageContext } from "~/lib/composerContextRecords";

/** The user's own words, without the citations they replied to unless nothing else is left. */
export function withoutRepliedCitations(text: string): string {
  let own = "";
  let cursor = 0;
  for (const match of collectAssistantCitations(text)) {
    own += text.slice(cursor, match.start);
    cursor = match.end;
  }
  own = (own + text.slice(cursor)).trim();
  return own || assistantCitationsToPlainText(text).trim();
}

export function userMessageFileLabel(file: Pick<ChatFileAttachment, "name" | "source">) {
  return file.source?._tag === "pasted-text" ? "Pasted text" : file.name;
}

/** The words a reply quotes: as the row shows them, without the citations they replied to. */
export function userMessageReplyText(message: ChatMessage): string {
  const presentation = resolveUserMessagePresentation(message);
  const context = resolveUserMessageContext({ ...message, text: presentation.text });
  return withoutRepliedCitations(
    replaceComposerContextReferences(context.text, (reference) => reference.label),
  );
}

export function resolvePreviewAnnotationImage(input: {
  record: Extract<KnownComposerContextRecord, { kind: "preview-annotation" }>;
  recordsById: ReadonlyMap<string, ComposerContextRecord>;
  userImages: ReadonlyArray<ChatImageAttachment>;
  previewImages: ReadonlyArray<ChatImageAttachment>;
  annotationRecordIds: ReadonlyArray<string>;
}): ChatImageAttachment | null {
  const screenshotRecord = input.record.screenshotContextId
    ? asKnownContextRecord(input.recordsById.get(input.record.screenshotContextId))
    : undefined;
  return (
    (screenshotRecord?.kind === "image"
      ? input.userImages.find((image) => image.id === screenshotRecord.attachmentId)
      : undefined) ??
    input.previewImages.find(
      (image) => image.name === `preview-annotation-${input.record.annotationId}.png`,
    ) ??
    input.previewImages[input.annotationRecordIds.indexOf(input.record.contextId)] ??
    null
  );
}
