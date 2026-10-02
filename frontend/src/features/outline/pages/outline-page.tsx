import { Box, Button, Flex, Select, Text } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";

import { ConfirmDialog, Spinner } from "@/components";
import { MobileAppSidebarTrigger, useAppShell } from "@/features/app-shell";
import { useProjectSelection } from "@/features/projects/hooks/use-project-selection";
import { useMobileSidebarSwipe } from "@/hooks/use-mobile-sidebar-swipe";
import { fetchChapters } from "@/lib/api-client";
import { getRecentProjects } from "@/lib/local-db";

import { OutlineAiActions } from "../components/outline-ai-actions";
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
import type { OutlineAiSplitItem } from "../lib/outline-ai-api";

import "./outline-page.css";

const OUTLINE_PROJECT_STORAGE_KEY = "openfix.outline.projectId";

function readStoredOutlineProject(): string | null {
  try {
    return localStorage.getItem(OUTLINE_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeOutlineProject(projectId: string): void {
  try {
    localStorage.setItem(OUTLINE_PROJECT_STORAGE_KEY, projectId);
  } catch {
    // Storage failures only lose the convenience of remembering the project.
  }
}

export function OutlinePage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { closeSidebar, isMobile, isSidebarOpen, openSidebar } = useAppShell();
  const queryClient = useQueryClient();
  const mobileSidebarSwipeHandlers = useMobileSidebarSwipe({
    isEnabled: isMobile,
    isOpen: isSidebarOpen,
    onOpen: openSidebar,
    onClose: closeSidebar,
  });

  const [projectId, setProjectId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isEditorDirty, setIsEditorDirty] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<OutlineNode | null>(null);
  // 立即读取的当前项目：URL 校验与偏好回退的异步续跑必须与它比较，不能依赖渲染快照。
  const projectIdRef = useRef<string | null>(null);

  // 只有真正切换项目才清空节点选中/脏标记/展开状态；重复设置同一项目保留编辑器内容。
  // 选中的项目写入既有本地偏好 key，使列表外项目在页面重挂载后仍能经接口恢复。
  const setCurrentProject = useCallback((nextProjectId: string | null) => {
    if (projectIdRef.current === nextProjectId) return;
    projectIdRef.current = nextProjectId;
    setProjectId(nextProjectId);
    setSelectedId(null);
    setIsEditorDirty(false);
    setExpandedIds(new Set());
    if (nextProjectId) storeOutlineProject(nextProjectId);
  }, []);

  const getCurrentProjectId = useCallback(() => projectIdRef.current, []);

  const { data: recentProjects = [], isPending: isRecentProjectsPending } = useQuery({
    queryKey: ["recent-projects"],
    queryFn: getRecentProjects,
    staleTime: Infinity,
  });

  const readProjectCandidates = useCallback(
    () =>
      Promise.resolve([
        readStoredOutlineProject(),
        ...recentProjects.map((recentProject) => recentProject.projectId),
      ]),
    [recentProjects],
  );

  // 当前项目初始化（第一页列表 + URL 深层链接 + 本地偏好/最近项目回退）统一由共享 hook 负责，
  // 页面不再自行解析 URL 或从原始参数初始化，避免未校验 id 直接驱动大纲请求。
  const { projects, isLoadingProjects, selectProjectManually } = useProjectSelection({
    urlProjectId: searchParams.get("projectId"),
    getCurrentProjectId,
    setCurrentProject,
    isPreferenceReady: !isRecentProjectsPending,
    getPreferenceCandidates: readProjectCandidates,
  });

  const {
    data: nodes = [],
    isLoading: isLoadingNodes,
    isFetching: isFetchingNodes,
  } = useQuery({
    queryKey: ["outlines", projectId],
    queryFn: () => fetchOutlines(projectId ?? ""),
    enabled: Boolean(projectId),
  });

  const { data: chapterTree } = useQuery({
    queryKey: ["project-chapter-tree", projectId],
    queryFn: () => fetchChapters(projectId ?? ""),
    enabled: Boolean(projectId),
  });
  const chapters = useMemo(
    () => (chapterTree?.volumes ?? []).flatMap((volume) => volume.chapters ?? []),
    [chapterTree],
  );

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
      setIsEditorDirty(false);
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

  // AI 拆分章节：仅创建用户确认过的候选子节点，逐条串行以保证排序稳定。
  const applySplitMutation = useMutation({
    mutationFn: async ({ parent, items }: { parent: OutlineNode; items: OutlineAiSplitItem[] }) => {
      if (!projectId) throw new Error("no project");
      const level = defaultChildLevel(parent.level);
      let completedCount = 0;
      for (const item of items) {
        try {
          await createOutline(projectId, {
            level,
            title: item.title,
            content: item.content,
            parent_id: parent.id,
          });
          completedCount += 1;
        } catch {
          const error = new Error("split apply failed") as Error & {
            completedCount: number;
          };
          error.completedCount = completedCount;
          throw error;
        }
      }
    },
    onSuccess: (_result, variables) => {
      setExpandedIds((current) => new Set(current).add(variables.parent.id));
      invalidate();
    },
    onError: () => {
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

  // 下拉框手动选择交给共享 hook：推进手动选择版本号，
  // 同时由 setCurrentProject 负责状态重置与本地偏好写入。
  const handleProjectChange = (value: string) => {
    selectProjectManually(value);
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
                onSelect={(node) => {
                  setIsEditorDirty(false);
                  setSelectedId(node.id);
                }}
                onToggleExpand={handleToggleExpand}
                onAddChild={handleAddChild}
              />
            )}
          </Box>
          <Box className="outline-page__editor">
            {selectedNode ? (
              <>
                <OutlineAiActions
                  key={selectedNode.id}
                  projectId={projectId ?? ""}
                  node={selectedNode}
                  chapters={chapters}
                  isApplying={applySplitMutation.isPending || updateMutation.isPending}
                  hasUnsavedChanges={isEditorDirty}
                  onApplyDraft={async ({ title, content }) => {
                    await updateMutation.mutateAsync({
                      outlineId: selectedNode.id,
                      payload: { title, content },
                    });
                  }}
                  onApplySplit={async (items) => {
                    await applySplitMutation.mutateAsync({ parent: selectedNode, items });
                  }}
                />
                <OutlineEditor
                  key={selectedNode.id}
                  node={selectedNode}
                  isSaving={updateMutation.isPending}
                  onDirtyChange={setIsEditorDirty}
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
              </>
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
