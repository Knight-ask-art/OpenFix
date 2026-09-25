export type ChapterExportFormat = "txt" | "docx";

export interface ChapterExportCreate {
  selectedVolumeIds: string[];
  includedChapterIds: string[];
  excludedChapterIds: string[];
  localDate: string;
  format: ChapterExportFormat;
}

export interface ChapterExport {
  id: string;
  status: string;
  filename: string;
  mode: "chapters" | "volumes";
  format: ChapterExportFormat;
  volumeCount: number;
  chapterCount: number;
  wordCount: number;
  chapterIds: string[];
  current: number;
  total: number;
  stage: string | null;
  chapterTitle: string | null;
  expiresAt: string | null;
  downloadUrl: string | null;
  errorMessage: string | null;
}
