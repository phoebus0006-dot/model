export interface ApplyDependencies {
  createOrUpdateFigure(data: any): Promise<any>;
  updateRelations(figureId: bigint, relations: any): Promise<void>;
  storeImages(figureId: bigint, images: any[]): Promise<{ created: number; errors: any[] }>;
  createRevision(figureId: bigint, data: any): Promise<any>;
  setCurrentRevision(figureId: bigint, revisionId: bigint): Promise<void>;
  invalidateCache(pattern: string): Promise<void>;
}
