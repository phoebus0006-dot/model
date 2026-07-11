export interface Figure {
  id: string;
  slug: string;
  name: string;
  nameJp?: string;
  nameEn?: string;
  janCode?: string;
  series?: EntityRef;
  manufacturer?: EntityRef;
  sculptor?: EntityRef;
  category?: EntityRef;
  images?: FigureImage[];
  scale?: string;
  material?: string;
  priceJpy?: number;
  releaseDate?: string;
  heightMm?: number;
  weightG?: number;
  productLine?: string;
  ageRating?: string;
  mfcId?: string;
  description?: string;
  isDeleted?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FigureImage {
  id: string;
  janCode?: string;
  sha256?: string;
  size: "raw" | "detail" | "thumb";
  format: string;
  width?: number;
  height?: number;
  fileSize?: number;
  source?: string;
  url?: string;
  alt?: string;
  sortOrder: number;
  isNsfw?: boolean;
}

export interface EntityRef {
  id: string;
  slug: string;
  name: string;
}

export interface Series extends EntityRef {}
export interface Manufacturer extends EntityRef {}
export interface Sculptor extends EntityRef {}
export interface Character extends EntityRef {}
export interface Category extends EntityRef {}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  meta: {
    count: number;
    total?: number;
    limit: number;
    offset: number;
  };
}

export interface SingleResponse<T> {
  success: boolean;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}
