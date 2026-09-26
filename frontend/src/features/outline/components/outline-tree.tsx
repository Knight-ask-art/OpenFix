import { Box, Flex, IconButton, Text, Tooltip } from "@radix-ui/themes";
import {
  BookOpenText,
  ChevronDown,
  ChevronRight,
  FileText,
  Layers,
  Plus,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

import type { OutlineLevel, OutlineNode } from "../lib/outline-api";

import "./outline-tree.css";

const LEVEL_ICONS: Record<OutlineLevel, LucideIcon> = {
  book: BookOpenText,
  arc: Waypoints,
  volume: Layers,
  chapter: FileText,
};

interface OutlineTreeProps {
  nodes: OutlineNode[];
  selectedId: string | null;
  expandedIds: Set<string>;
  addChildLabel: string;
  emptyLabel: string;
  levelLabels: Record<OutlineLevel, string>;
  onSelect: (node: OutlineNode) => void;
  onToggleExpand: (nodeId: string) => void;
  onAddChild: (parent: OutlineNode | null) => void;
}

export function OutlineTree({
  nodes,
  selectedId,
  expandedIds,
  addChildLabel,
  emptyLabel,
  levelLabels,
  onSelect,
  onToggleExpand,
  onAddChild,
}: OutlineTreeProps) {
  const childrenByParent = new Map<string, OutlineNode[]>();
  for (const node of nodes) {
    if (node.parent_id === null) continue;
    const siblings = childrenByParent.get(node.parent_id) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parent_id, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((left, right) => left.sort_order - right.sort_order);
  }
  const roots = nodes
    .filter((node) => node.parent_id === null)
    .sort((left, right) => left.sort_order - right.sort_order);

  const renderNode = (node: OutlineNode, depth: number) => {
    const children = childrenByParent.get(node.id) ?? [];
    const isExpanded = expandedIds.has(node.id);
    const LevelIcon = LEVEL_ICONS[node.level] ?? FileText;
    return (
      <Box key={node.id}>
        <div
          className={`outline-tree__row${selectedId === node.id ? " outline-tree__row--selected" : ""}`}
          style={{ paddingLeft: `${8 + depth * 18}px` }}
        >
          {children.length > 0 ? (
            <button
              type="button"
              className="outline-tree__expander"
              aria-label={isExpanded ? "collapse" : "expand"}
              aria-expanded={isExpanded}
              onClick={() => onToggleExpand(node.id)}
            >
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : (
            <span className="outline-tree__expander outline-tree__expander--placeholder" />
          )}
          <LevelIcon
            size={14}
            className="outline-tree__icon"
            aria-hidden="true"
          />
          <button
            type="button"
            className="outline-tree__label"
            onClick={() => onSelect(node)}
            title={node.title}
          >
            {node.title || levelLabels[node.level]}
          </button>
          <Tooltip content={addChildLabel}>
            <IconButton
              size="1"
              variant="ghost"
              color="gray"
              aria-label={addChildLabel}
              onClick={() => onAddChild(node)}
            >
              <Plus size={13} />
            </IconButton>
          </Tooltip>
        </div>
        {isExpanded ? (
          <Box>
            {children.map((child) => renderNode(child, depth + 1))}
          </Box>
        ) : null}
      </Box>
    );
  };

  if (nodes.length === 0) {
    return (
      <Flex
        direction="column"
        gap="3"
        align="center"
        className="outline-tree__empty"
      >
        <Text
          size="2"
          color="gray"
        >
          {emptyLabel}
        </Text>
      </Flex>
    );
  }

  return (
    <Box
      className="outline-tree"
      role="tree"
      aria-label="outline"
    >
      {roots.map((node) => renderNode(node, 0))}
    </Box>
  );
}
