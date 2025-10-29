export interface Book {
  id?: string;
  title: string;
  author?: string;
  isbn?: string;
  confidence?: string;
  status?: 'pending' | 'approved' | 'rejected' | 'incomplete';
  scannedAt?: number;
  coverUrl?: string;
  googleBooksId?: string;
}

export interface Photo {
  id: string;
  uri: string;
  books: Book[];
  timestamp: number;
}

export interface User {
  uid: string;
  email: string;
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
