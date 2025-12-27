/**
 * Supabase Sync Service
 * 
 * This service handles syncing books and photos to/from Supabase.
 * It ensures all user data is permanently stored in the cloud and
 * persists across app versions and devices.
 */

import { supabase } from '../lib/supabaseClient';
import { Book, Photo } from '../types/BookTypes';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';

/**
 * Upload a photo to Supabase Storage and return the public URL
 */
export async function uploadPhotoToStorage(
  userId: string,
  photoId: string,
  localUri: string
): Promise<{ storagePath: string; storageUrl: string } | null> {
  if (!supabase) {
    console.warn('Supabase not available, skipping photo upload');
    return null;
  }

  try {
    // Read the file as base64
    const base64 = await FileSystem.readAsStringAsync(localUri, {
      encoding: FileSystem.EncodingType.Base64,
    });

    // Decode base64 to binary for Supabase Storage
    // Simple base64 decoder for React Native (no atob available)
    const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
      // Remove data URL prefix if present
      const cleanBase64 = base64.includes(',') ? base64.split(',')[1] : base64;
      
      // Base64 character set
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const lookup = new Uint8Array(256);
      for (let i = 0; i < chars.length; i++) {
        lookup[chars.charCodeAt(i)] = i;
      }
      
      let bufferLength = cleanBase64.length * 0.75;
      if (cleanBase64[cleanBase64.length - 1] === '=') {
        bufferLength--;
        if (cleanBase64[cleanBase64.length - 2] === '=') {
          bufferLength--;
        }
      }
      
      const bytes = new Uint8Array(bufferLength);
      let p = 0;
      
      for (let i = 0; i < cleanBase64.length; i += 4) {
        const encoded1 = lookup[cleanBase64.charCodeAt(i)];
        const encoded2 = lookup[cleanBase64.charCodeAt(i + 1)];
        const encoded3 = lookup[cleanBase64.charCodeAt(i + 2)];
        const encoded4 = lookup[cleanBase64.charCodeAt(i + 3)];
        
        bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
        bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
        bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
      }
      
      return bytes.buffer;
    };

    const arrayBuffer = base64ToArrayBuffer(base64);

    // Upload to Supabase Storage
    const storagePath = `${userId}/${photoId}.jpg`;
    const { data, error } = await supabase.storage
      .from('photos')
      .upload(storagePath, arrayBuffer, {
        contentType: 'image/jpeg',
        upsert: true, // Overwrite if exists
      });

    if (error) {
      console.error('Error uploading photo to storage:', error);
      return null;
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('photos')
      .getPublicUrl(storagePath);

    return {
      storagePath,
      storageUrl: urlData.publicUrl,
    };
  } catch (error) {
    console.error('Error uploading photo:', error);
    return null;
  }
}

/**
 * Download a photo from Supabase Storage to local cache
 */
export async function downloadPhotoFromStorage(
  storageUrl: string,
  photoId: string
): Promise<string | null> {
  if (!FileSystem.documentDirectory) {
    console.warn('FileSystem document directory not available');
    return null;
  }

  try {
    // Create photos directory if it doesn't exist
    const photosDirPath = `${FileSystem.documentDirectory}photos/`;
    const dirInfo = await FileSystem.getInfoAsync(photosDirPath);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(photosDirPath, { intermediates: true });
    }

    const localPath = `photos/${photoId}.jpg`;
    const fullPath = `${FileSystem.documentDirectory}${localPath}`;

    // Check if already cached
    const existingFile = await FileSystem.getInfoAsync(fullPath);
    if (existingFile.exists) {
      return localPath;
    }

    // Download the image
    const downloadResult = await FileSystem.downloadAsync(storageUrl, fullPath);

    if (downloadResult.uri) {
      return localPath;
    }

    return null;
  } catch (error) {
    console.error('Error downloading photo from storage:', error);
    return null;
  }
}

/**
 * Save a photo to Supabase (both storage and database)
 */
export async function savePhotoToSupabase(
  userId: string,
  photo: Photo
): Promise<boolean> {
  if (!supabase) {
    console.warn('Supabase not available, skipping photo save');
    return false;
  }

  try {
    // Upload photo to storage
    let storagePath = '';
    let storageUrl = '';

    // Check if photo.uri is already a storage URL
    if (photo.uri.startsWith('http') && photo.uri.includes('supabase.co')) {
      // Already uploaded, extract path from URL
      storageUrl = photo.uri;
      const urlParts = photo.uri.split('/');
      const pathIndex = urlParts.findIndex(part => part === 'photos');
      if (pathIndex !== -1) {
        storagePath = urlParts.slice(pathIndex).join('/');
      }
    } else {
      // Upload to storage
      const uploadResult = await uploadPhotoToStorage(userId, photo.id, photo.uri);
      if (!uploadResult) {
        console.error('Failed to upload photo to storage');
        return false;
      }
      storagePath = uploadResult.storagePath;
      storageUrl = uploadResult.storageUrl;
    }

    // Save photo metadata to database
    const { error } = await supabase
      .from('photos')
      .upsert({
        id: photo.id,
        user_id: userId,
        storage_path: storagePath,
        storage_url: storageUrl,
        books: photo.books,
        timestamp: photo.timestamp,
        caption: photo.caption || null,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'id',
      });

    if (error) {
      console.error('Error saving photo to database:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error saving photo to Supabase:', error);
    return false;
  }
}

/**
 * Load all photos from Supabase for a user
 */
export async function loadPhotosFromSupabase(userId: string): Promise<Photo[]> {
  if (!supabase) {
    console.warn('Supabase not available, returning empty photos');
    return [];
  }

  try {
    const { data, error } = await supabase
      .from('photos')
      .select('*')
      .eq('user_id', userId)
      .order('timestamp', { ascending: false });

    if (error) {
      console.error('Error loading photos from Supabase:', error);
      return [];
    }

    if (!data) {
      return [];
    }

    // Convert Supabase data to Photo objects
    const photos: Photo[] = await Promise.all(
      data.map(async (row) => {
        // Download photo to local cache for offline access
        const localPath = await downloadPhotoFromStorage(row.storage_url, row.id);
        
        return {
          id: row.id,
          uri: localPath ? `${FileSystem.documentDirectory}${localPath}` : row.storage_url,
          books: (row.books || []) as Book[],
          timestamp: row.timestamp,
          caption: row.caption || undefined,
        };
      })
    );

    return photos;
  } catch (error) {
    console.error('Error loading photos from Supabase:', error);
    return [];
  }
}

/**
 * Save a book to Supabase
 */
export async function saveBookToSupabase(
  userId: string,
  book: Book,
  status: 'pending' | 'approved' | 'rejected' | 'incomplete'
): Promise<boolean> {
  if (!supabase) {
    console.warn('Supabase not available, skipping book save');
    return false;
  }

  try {
    const bookData = {
      user_id: userId,
      title: book.title,
      author: book.author || null,
      isbn: book.isbn || null,
      confidence: book.confidence || null,
      status: status,
      scanned_at: book.scannedAt || null,
      cover_url: book.coverUrl || null,
      local_cover_path: book.localCoverPath || null,
      google_books_id: book.googleBooksId || null,
      description: book.description || null,
      // Google Books API stats fields
      page_count: book.pageCount || null,
      categories: book.categories || null,
      publisher: book.publisher || null,
      published_date: book.publishedDate || null,
      language: book.language || null,
      average_rating: book.averageRating || null,
      ratings_count: book.ratingsCount || null,
      subtitle: book.subtitle || null,
      print_type: book.printType || null,
      updated_at: new Date().toISOString(),
    };

    // Use upsert to insert or update based on user_id + title + author
    const authorForQuery = book.author || '';
    const { data: existingBook, error: findError } = await supabase
      .from('books')
      .select('id')
      .eq('user_id', userId)
      .eq('title', book.title)
      .eq('author', authorForQuery)
      .maybeSingle();

    if (findError && findError.code !== 'PGRST116') {
      // PGRST116 is "not found" which is fine
      console.warn('Error finding book in Supabase:', findError);
    }

    if (existingBook) {
      // Update existing book
      const { error: updateError } = await supabase
        .from('books')
        .update(bookData)
        .eq('id', existingBook.id);

      if (updateError) {
        console.error('Error updating book in Supabase:', updateError);
        return false;
      }
    } else {
      // Insert new book
      const { error: insertError } = await supabase
        .from('books')
        .insert(bookData);

      if (insertError) {
        console.error('Error inserting book to Supabase:', insertError);
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error('Error saving book to Supabase:', error);
    return false;
  }
}

/**
 * Load all books from Supabase for a user, grouped by status
 */
export async function loadBooksFromSupabase(
  userId: string
): Promise<{
  pending: Book[];
  approved: Book[];
  rejected: Book[];
}> {
  if (!supabase) {
    console.warn('Supabase not available, returning empty books');
    return { pending: [], approved: [], rejected: [] };
  }

  try {
    const { data, error } = await supabase
      .from('books')
      .select('*')
      .eq('user_id', userId)
      .order('scanned_at', { ascending: false, nullsFirst: false });

    if (error) {
      console.error('Error loading books from Supabase:', error);
      return { pending: [], approved: [], rejected: [] };
    }

    if (!data) {
      return { pending: [], approved: [], rejected: [] };
    }

    // Convert Supabase data to Book objects and group by status
    const books: Book[] = data.map((row) => ({
      id: `${row.title}_${row.author || ''}_${row.scanned_at || ''}`,
      title: row.title,
      author: row.author || undefined,
      isbn: row.isbn || undefined,
      confidence: row.confidence || undefined,
      status: row.status || 'pending',
      scannedAt: row.scanned_at || undefined,
      coverUrl: row.cover_url || undefined,
      localCoverPath: row.local_cover_path || undefined,
      googleBooksId: row.google_books_id || undefined,
      description: row.description || undefined,
      // Google Books API stats fields
      pageCount: row.page_count || undefined,
      categories: row.categories || undefined,
      publisher: row.publisher || undefined,
      publishedDate: row.published_date || undefined,
      language: row.language || undefined,
      averageRating: row.average_rating ? Number(row.average_rating) : undefined,
      ratingsCount: row.ratings_count || undefined,
      subtitle: row.subtitle || undefined,
      printType: row.print_type || undefined,
    }));

    const pending = books.filter((b) => b.status === 'pending' || b.status === 'incomplete');
    const approved = books.filter((b) => b.status === 'approved');
    const rejected = books.filter((b) => b.status === 'rejected');

    return { pending, approved, rejected };
  } catch (error) {
    console.error('Error loading books from Supabase:', error);
    return { pending: [], approved: [], rejected: [] };
  }
}

/**
 * Delete a photo from Supabase (both storage and database)
 */
export async function deletePhotoFromSupabase(
  userId: string,
  photoId: string
): Promise<boolean> {
  if (!supabase) {
    console.warn('Supabase not available, skipping photo deletion');
    return false;
  }

  try {
    // Get photo to find storage path
    const { data: photoData, error: fetchError } = await supabase
      .from('photos')
      .select('storage_path')
      .eq('id', photoId)
      .eq('user_id', userId)
      .single();

    if (fetchError) {
      console.error('Error fetching photo for deletion:', fetchError);
    }

    // Delete from storage if path exists
    if (photoData?.storage_path) {
      const { error: storageError } = await supabase.storage
        .from('photos')
        .remove([photoData.storage_path]);

      if (storageError) {
        console.error('Error deleting photo from storage:', storageError);
      }
    }

    // Delete from database
    const { error: deleteError } = await supabase
      .from('photos')
      .delete()
      .eq('id', photoId)
      .eq('user_id', userId);

    if (deleteError) {
      console.error('Error deleting photo from database:', deleteError);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error deleting photo from Supabase:', error);
    return false;
  }
}

/**
 * Delete a book from Supabase
 */
export async function deleteBookFromSupabase(
  userId: string,
  book: Book
): Promise<boolean> {
  if (!supabase) {
    console.warn('Supabase not available, skipping book deletion');
    return false;
  }

  try {
    const authorForQuery = book.author || '';
    const { error } = await supabase
      .from('books')
      .delete()
      .eq('user_id', userId)
      .eq('title', book.title)
      .eq('author', authorForQuery);

    if (error) {
      console.error('Error deleting book from Supabase:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error deleting book from Supabase:', error);
    return false;
  }
}

