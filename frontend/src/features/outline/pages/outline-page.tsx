import { Box, Button, Flex, Select, Text } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog, Spinner } from "@/components";
import { MobileAppSidebarTrigger, useAppShell } from "@/features/app-shell";
import { useProjects } from "@/features/projects";
import { useMobileSidebarSwipe } from "@/hooks/use-mobile-sidebar-swipe";
import { getRecentProjects } from "@/lib/local-db";
import type { RecentProject } from "@/lib/recent-projects";

import { OutlineEditor } from "../components/outline-editor";
import { OutlineTree } from "../components/outline-tree";
import {
  createOutline,
  defaultChildLevel,
  deleteOutline,
  fetchOutlines,
  updateOutline,
  type OutlineLevel,
  type OutlineNode,
} from "../lib/outline-api";

import "./outline-page.css";

const OUTLINE_PROJECT_STORAGE_KEY = "openfix.outline.projectId";

function readStoredOutlineProject(): string | null {
  try {
    return localStorage.getItem(OUTLINE_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function OutlinePage() {
  const { t } = useTranslation();
  const { closeSidebar, isMobile, isSidebarOpen, openSidebar } = useAppShell();
  const queryClient = useQueryClient();
  const mobileSidebarSwipeHandlers = useMobileSidebarSwipe({
    isEnabled: isMobile,
    isOpen: isSidebarOpen,
    onOpen: openSidebar,
    onClose: closeSidebar,
  });

  const { data: projectsData, isLoading: isLoadingProjects } = useProjects({
    page: 1,
    pageSize: 100,
  });
  const projects = useMemo(() => projectsData?.items ?? [], [projectsData]);
  const { data: recentProjects = [] } = useQuery({
    queryKey: ["recent-projects"],
    queryFn: getRecentProjects,
    staleTime: Infinity,
  });

  const [projectId, setProjectId] = useState<string | null>(() => readStoredOutlineProject());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<OutlineNode | null>(null);

  useEffect(() => {
    if (projectId) return;
    if (projects.length === 0) return;
    const preferred =
      (recentProjects as RecentProject[]).find((item) =>
        projects.some((project) => project.id === item.projectId),
      )?.projectId ?? projects[0].id;
    setProjectId(preferred);
  }, [projectId, projects, recentProjects]);

  const {
    data: nodes = [],
    isLoading: isLoadingNodes,
    isFetching: isFetchingNodes,
  } = useQuery({
    queryKey: ["outlines", projectId],
    queryFn: () => fetchOutlines(projectId ?? ""),
    enabled: Boolean(projectId),
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["outlines", projectId] });
  }, [projectId, queryClient]);

  const createMutation = useMutation({
    mutationFn: (parent: OutlineNode | null) =>
      createOutline(projectId ?? "", {
        level: defaultChildLevel(parent ? parent.level : null),
        title: "",
        content: "",
        parent_id: parent ? parent.id : null,
      }),
    onSuccess: (created) => {
      if (created.parent_id) {
        setExpandedIds((current) => new Set(current).add(created.parent_id as string));
      }
      setSelectedId(created.id);
      invalidate();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ outlineId, payload }: { outlineId: string; payload: Parameters<typeof updateOutline>[2] }) =>
      updateOutline(projectId ?? "", outlineId, payload),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (outlineId: string) => deleteOutline(projectId ?? "", outlineId),
    onSuccess: (_count, outlineId) => {
      if (selectedId === outlineId) setSelectedId(null);
      setDeleteTarget(null);
      invalidate();
    },
  });

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );
  const childCount = useMemo(
    () => (selectedNode ? nodes.filter((node) => node.parent_id === selectedNode.id).length : 0),
    [nodes, selectedNode],
  );

  const levelLabels: Record<OutlineLevel, string> = {
    book: t("outline.levels.book"),
    arc: t("outline.levels.arc"),
    volume: t("outline.levels.volume"),
    chapter: t("outline.levels.chapter"),
  };

  const handleProjectChange = (value: string) => {
    setProjectId(value);
    setSelectedId(null);
    setExpandedIds(new Set());
    try {
      localStorage.setItem(OUTLINE_PROJECT_STORAGE_KEY, value);
    } catch {
      // Storage failures only lose the convenience of remembering the project.
    }
  };

  const handleAddRoot = () => {
    if (projectId) void createMutation.mutateAsync(null);
  };

  const handleAddChild = (parent: OutlineNode | null) => {
    void createMutation.mutateAsync(parent);
  };

  const handleToggleExpand = (nodeId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const confirmLabels = {
    title: t("outline.title"),
    content: t("outline.content"),
    level: t("outline.level"),
    save: t("outline.save"),
    deleteNode: t("outline.delete"),
    deleteWithChildren: (count: number) => t("outline.deleteWithChildren", { count }),
    untitled: t("outline.untitled"),
  };

  return (
    <Box
      {...mobileSidebarSwipeHandlers}
      className="outline-page mobile-sidebar-swipe-surface"
    >
      <Box className="outline-page__header">
        <Flex
          align="center"
          gap="3"
        >
          <MobileAppSidebarTrigger />
          <Text
            size="5"
            weight="medium"
          >
            {t("outline.title")}
          </Text>
          <Box className="outline-page__project-select">
            {isLoadingProjects ? (
              <Spinner size={18} />
            ) : (
              <Select.Root
                value={projectId ?? ""}
                onValueChange={handleProjectChange}
              >
                <Select.Trigger variant="soft" />
                <Select.Content>
                  {projects.map((project) => (
                    <Select.Item
                      key={project.id}
                      value={project.id}
                    >
                      {project.title}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            )}
          </Box>
          <Button
            size="2"
            variant="soft"
            disabled={!projectId || createMutation.isPending}
            onClick={handleAddRoot}
          >
            <Plus size={14} />
            {t("outline.addRoot")}
          </Button>
        </Flex>
      </Box>

      {!projectId ? (
        <Flex
          className="outline-page__empty"
          direction="column"
          align="center"
          justify="center"
          gap="2"
        >
          <Text
            size="3"
            color="gray"
          >
            {t("outline.noProject")}
          </Text>
        </Flex>
      ) : (
        <Box className="outline-page__body">
          <Box className="outline-page__tree">
            {isLoadingNodes ? (
              <Flex
                justify="center"
                pt="6"
              >
                <Spinner size={18} />
              </Flex>
            ) : (
              <OutlineTree
                nodes={nodes}
                selectedId={selectedId}
                expandedIds={expandedIds}
                addChildLabel={t("outline.addChild")}
                emptyLabel={t("outline.emptyTree")}
                levelLabels={levelLabels}
                onSelect={(node) => setSelectedId(node.id)}
                onToggleExpand={handleToggleExpand}
                onAddChild={handleAddChild}
              />
            )}
          </Box>
          <Box className="outline-page__editor">
            {selectedNode ? (
              <OutlineEditor
                key={selectedNode.id}
                node={selectedNode}
                isSaving={updateMutation.isPending}
                labels={confirmLabels}
                levelLabels={levelLabels}
                childCount={childCount}
                onSave={(payload) =>
                  updateMutation.mutate(
                    { outlineId: selectedNode.id, payload },
                  )
                }
                onDelete={() => setDeleteTarget(selectedNode)}
              />
            ) : (
              <Flex
                className="outline-page__editor-empty"
                align="center"
                justify="center"
              >
                <Text
                  size="2"
                  color="gray"
                >
                  {isFetchingNodes ? "" : t("outline.selectNode")}
                </Text>
              </Flex>
            )}
          </Box>
        </Box>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={() => {
          if (deleteTarget) void deleteMutation.mutateAsync(deleteTarget.id);
        }}
        title={t("outline.delete")}
        description={t("outline.deleteConfirm", {
          title: deleteTarget?.title || t("outline.untitled"),
        })}
        confirmText={t("common.delete")}
        confirmColor="red"
        loading={deleteMutation.isPending}
      />
    </Box>
  );
}
