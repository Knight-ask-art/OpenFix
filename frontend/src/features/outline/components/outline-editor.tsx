import { Box, Button, Flex, Select, TextArea, Text, TextField } from "@radix-ui/themes";
import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  OUTLINE_LEVELS,
  type OutlineLevel,
  type OutlineNode,
  type OutlineUpdatePayload,
} from "../lib/outline-api";

import "./outline-editor.css";

interface OutlineEditorProps {
  node: OutlineNode;
  isSaving: boolean;
  labels: {
    title: string;
    content: string;
    level: string;
    save: string;
    deleteNode: string;
    deleteWithChildren: (count: number) => string;
    untitled: string;
  };
  levelLabels: Record<OutlineLevel, string>;
  childCount: number;
  onSave: (payload: OutlineUpdatePayload) => void;
  onDelete: () => void;
}

export function OutlineEditor({
  node,
  isSaving,
  labels,
  levelLabels,
  childCount,
  onSave,
  onDelete,
}: OutlineEditorProps) {
  const [title, setTitle] = useState(node.title);
  const [content, setContent] = useState(node.content);
  const [level, setLevel] = useState<OutlineLevel>(node.level);

  useEffect(() => {
    setTitle(node.title);
    setContent(node.content);
    setLevel(node.level);
  }, [node.id, node.title, node.content, node.level]);

  const isDirty = useMemo(
    () => title !== node.title || content !== node.content || level !== node.level,
    [title, content, level, node],
  );

  const handleSave = () => {
    if (!isDirty || isSaving) return;
    onSave({ title: title.trim(), content, level });
  };

  return (
    <Box className="outline-editor">
      <Flex
        direction="column"
        gap="3"
      >
        <Flex
          gap="3"
          wrap="wrap"
        >
          <Box style={{ flex: 1, minWidth: 200 }}>
            <Text
              size="1"
              color="gray"
            >
              {labels.title}
            </Text>
            <TextField.Root
              value={title}
              placeholder={labels.untitled}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Box>
          <Box>
            <Text
              size="1"
              color="gray"
            >
              {labels.level}
            </Text>
            <Select.Root
              value={level}
              onValueChange={(value) => setLevel(value as OutlineLevel)}
            >
              <Select.Trigger variant="soft" />
              <Select.Content>
                {OUTLINE_LEVELS.map((item) => (
                  <Select.Item
                    key={item}
                    value={item}
                  >
                    {levelLabels[item]}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Box>
        </Flex>

        <Box>
          <Text
            size="1"
            color="gray"
          >
            {labels.content}
          </Text>
          <TextArea
            value={content}
            rows={12}
            resize="vertical"
            onChange={(event) => setContent(event.target.value)}
          />
        </Box>

        <Flex
          justify="between"
          align="center"
        >
          <Button
            variant="soft"
            color="gray"
            size="2"
            disabled={isSaving}
            aria-label={labels.deleteNode}
            onClick={onDelete}
          >
            <Trash2 size={14} />
            {labels.deleteNode}
            {childCount > 0 ? ` (${labels.deleteWithChildren(childCount)})` : ""}
          </Button>
          <Button
            size="2"
            disabled={!isDirty || isSaving}
            loading={isSaving}
            onClick={handleSave}
          >
            {labels.save}
          </Button>
        </Flex>
      </Flex>
    </Box>
  );
}
