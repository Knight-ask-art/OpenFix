/**
 * Chapter Types
 *
 * 章节相关的 TypeScript 类型定义，与后端 Schema 对应。
 */

/**
 * 章节实体（完整版，包含正文）
 */
export interface Chapter {
  id: string;
  projectId: string;
  volumeId: string;
  title: string;
  content: string;
  wordCount: number;
  order: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 章节列表项（精简版，不含正文，用于列表展示）
 */
export interface ChapterListItem {
  id: string;
  projectId: string;
  volumeId: string;
  title: string;
  wordCount: number;
  order: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 创建章节请求
 */
export interface ChapterCreate {
  volumeId: string;
  title: string;
  content?: string;
  wordCount?: number;
}

/**
 * 更新章节请求
 */
export interface ChapterUpdate {
  title?: string;
  content?: string;
  wordCount?: number;
}

export interface Volume {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  order: number;
  chapterCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface VolumeWithChapters extends Volume {
  chapters: ChapterListItem[];
}

export interface VolumeTreeResponse {
  volumes: VolumeWithChapters[];
  totalChapters: number;
}

export interface VolumeCreate {
  title: string;
  description?: string | null;
}

export interface VolumeUpdate {
  title?: string;
  description?: string | null;
}

export interface VolumeMove {
  newOrder: number;
}

/**
 * 移动章节请求
 */
export interface ChapterMove {
  newOrder: number;
}

export interface ChapterMoveToVolume {
  volumeId: string;
}

/** 章节状态。 */
export type ChapterStatus = "draft" | "writing" | "revising" | "done";

/** 章节产品附加信息（状态与本章目标字数）。 */
export interface ChapterMeta {
  chapterId: string;
  projectId: string;
  status: ChapterStatus;
  targetWordCount: number;
  lastAiCheckAt: string | null;
  updatedAt: string;
}

/** 更新章节附加信息请求。 */
export interface ChapterMetaUpdate {
  status?: ChapterStatus;
  targetWordCount?: number;
}

export interface ChapterMetaListResponse {
  items: ChapterMeta[];
  total: number;
}
