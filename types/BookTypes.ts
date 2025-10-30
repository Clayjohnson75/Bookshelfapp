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
