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
  readAt?: number; // Timestamp when book was marked as read
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

export interface WishlistItem extends Book {
  addedAt: number; // Timestamp when added to wishlist
}
