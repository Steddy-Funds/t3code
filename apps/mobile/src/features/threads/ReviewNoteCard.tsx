import { type ReviewNote, reviewNoteRangeLabel } from "@t3tools/shared/reviewNote";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/** A note an agent left on lines it changed. Plain text: an agent's markup is never rendered. */
export function ReviewNoteCard(props: { readonly note: ReviewNote }) {
  const { note } = props;
  return (
    <View className="mb-3 gap-1.5 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="flex-row items-center gap-2">
        <Text
          textRole="caption"
          className="shrink font-mono"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {note.path}
        </Text>
        <Text textRole="caption" className="text-foreground-muted">
          {reviewNoteRangeLabel(note)}
        </Text>
      </View>
      <Text textRole="footnote" selectable>
        {note.note}
      </Text>
      {note.question ? (
        <Text textRole="footnote" className="font-medium" selectable>
          {note.question}
        </Text>
      ) : null}
    </View>
  );
}
