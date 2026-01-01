export interface Book {
  id?: string;
  title: string;
  author?: string;
  isbn?: string;
  confidence?: string;
  status?: 'pending' | 'approved' | 'rejected' | 'incomplete';
  scannedAt?: number;
  coverUrl?: string;
  localCoverPath?: string; // Local cached path for offline access
  googleBooksId?: string;
  description?: string; // Book description from Google Books API
  // Google Books API stats fields
  pageCount?: number; // Total number of pages
  categories?: string[]; // Genres/categories
  publisher?: string; // Publisher name
  publishedDate?: string; // Publication date (e.g., "2023" or "2023-01-15")
  language?: string; // Language code (e.g., "en")
  averageRating?: number; // Average rating (0-5)
  ratingsCount?: number; // Total number of ratings
  subtitle?: string; // Book subtitle
  printType?: string; // Print type (e.g., "BOOK")
  readAt?: number; // Timestamp when book was marked as read (null/undefined = unread)
}

export interface Photo {
  id: string;
  uri: string;
  books: Book[];
  timestamp: number;
  caption?: string; // Optional caption/label for the photo location
}

export interface User {
  uid: string;
  email: string;
  username: string; // Required unique identifier for speculation/search
  displayName?: string;
  photoURL?: string;
}

export interface UserProfile {
  displayName: string;
  email: string;
  photoURL?: string;
  createdAt: Date;
  lastLogin: Date;
  totalBooks: number;
  totalPhotos: number;
}

export interface Folder {
  id: string;
  name: string;
  bookIds: string[]; // Array of book IDs that belong to this folder
  photoIds: string[]; // Array of photo IDs that belong to this folder
  createdAt: number;
}
