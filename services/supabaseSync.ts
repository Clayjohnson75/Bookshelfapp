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
import { Platform } from 'react-native';

/**
 * Upload a book cover to Supabase Storage and return the public URL
 */
export async function uploadBookCoverToStorage(
  userId: string,
  bookId: string,
  localUri: string
): Promise<{ storagePath: string; storageUrl: string } | null> {
  if (!supabase) {
    console.warn('Supabase not available, skipping cover upload');
    return null;
  }

  try {
    // Check if file exists first
    let fileInfo = await FileSystem.getInfoAsync(localUri);
    if (!fileInfo.exists) {
      console.warn('Cover file does not exist:', localUri);
      return null;
    }

    // Resize and optimize the image if needed
    let imageUri = localUri;
    try {
      const manipulatedImage = await ImageManipulator.manipulateAsync(
        localUri,
        [{ resize: { width: 600 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
      );
      imageUri = manipulatedImage.uri;
    } catch (manipError) {
      console.warn('Error manipulating cover image, using original:', manipError);
      imageUri = localUri;
    }
    
    // Read the file as base64
    const base64 = await FileSystem.readAsStringAsync(imageUri, {
      encoding: FileSystem.EncodingType.Base64,
    });

    // Decode base64 to binary for Supabase Storage
    const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
      const cleanBase64 = base64.includes(',') ? base64.split(',')[1] : base64;
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

    // Upload to Supabase Storage (use 'photos' bucket or create 'covers' bucket)
    const storagePath = `${userId}/covers/${bookId}.jpg`;
    const { data, error } = await supabase.storage
      .from('photos')
      .upload(storagePath, arrayBuffer, {
        contentType: 'image/jpeg',
        upsert: true, // Overwrite if exists
      });

    if (error) {
      const errorMessage = error?.message || error?.code || JSON.stringify(error) || String(error);
      console.error('Error uploading cover to storage:', errorMessage);
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
    console.error('Error uploading cover:', error);
    return null;
  }
}

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
    // Check if file exists first
    let fileInfo = await FileSystem.getInfoAsync(localUri);
    if (!fileInfo.exists) {
      console.warn(`Photo file does not exist: ${localUri}`);
      return null;
    }
    
    // Always copy/convert to a permanent location to avoid temporary file cleanup issues
    // This is especially important for iOS ImagePicker and Camera files
    let imageUri = localUri;
    const isTemporaryPath = localUri.includes('ImagePicker') || localUri.includes('Camera') || localUri.includes('tmp');
    const isHeic = localUri.toLowerCase().endsWith('.heic');
    
    if (Platform.OS === 'ios' && (isTemporaryPath || isHeic)) {
      try {
        // Ensure document directory exists
        if (!FileSystem.documentDirectory) {
          console.error('Document directory not available');
          return null;
        }
        
        // Create photos directory if it doesn't exist
        const photosDir = `${FileSystem.documentDirectory}photos/`;
        const dirInfo = await FileSystem.getInfoAsync(photosDir);
        if (!dirInfo.exists) {
          await FileSystem.makeDirectoryAsync(photosDir, { intermediates: true });
        }
        
        // Use ImageManipulator to convert to JPEG and save to a permanent location
        const permanentPath = `${photosDir}${photoId}_${Date.now()}.jpg`;
        const manipulated = await ImageManipulator.manipulateAsync(
          localUri,
          [], // No transformations, just conversion
          {
            compress: 0.9,
            format: ImageManipulator.SaveFormat.JPEG,
          }
        );
        
        // Copy the manipulated file to our permanent location
        await FileSystem.copyAsync({
          from: manipulated.uri,
          to: permanentPath,
        });
        
        imageUri = permanentPath;
        
        // Verify the file exists
        fileInfo = await FileSystem.getInfoAsync(imageUri);
        if (!fileInfo.exists) {
          console.warn(`Permanent photo file does not exist after copy: ${imageUri}`);
          return null;
        }
      } catch (convertError) {
        console.warn('Error converting/copying image:', convertError);
        // If conversion fails, try to use original if it still exists
        fileInfo = await FileSystem.getInfoAsync(localUri);
        if (!fileInfo.exists) {
          console.warn(`Original photo file does not exist: ${localUri}`);
          return null;
        }
        // Use original if it exists
        imageUri = localUri;
      }
    } else if (isTemporaryPath) {
      // For non-iOS temporary files, copy to permanent location
      try {
        if (!FileSystem.documentDirectory) {
          console.error('Document directory not available');
          return null;
        }
        
        const photosDir = `${FileSystem.documentDirectory}photos/`;
        const dirInfo = await FileSystem.getInfoAsync(photosDir);
        if (!dirInfo.exists) {
          await FileSystem.makeDirectoryAsync(photosDir, { intermediates: true });
        }
        
        const permanentPath = `${photosDir}${photoId}_${Date.now()}.jpg`;
        await FileSystem.copyAsync({
          from: localUri,
          to: permanentPath,
        });
        
        imageUri = permanentPath;
        fileInfo = await FileSystem.getInfoAsync(imageUri);
        if (!fileInfo.exists) {
          console.warn(`Permanent photo file does not exist after copy: ${imageUri}`);
          return null;
        }
      } catch (copyError) {
        console.warn('Error copying temporary file:', copyError);
        // Try to use original
        fileInfo = await FileSystem.getInfoAsync(localUri);
        if (!fileInfo.exists) {
          console.warn(`Original photo file does not exist: ${localUri}`);
          return null;
        }
        imageUri = localUri;
      }
    }
    
    // Read the file as base64
    const base64 = await FileSystem.readAsStringAsync(imageUri, {
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
      const errorMessage = error?.message || error?.code || JSON.stringify(error) || String(error);
      
      if (error.code === '404' || errorMessage.includes('Bucket not found') || errorMessage.includes('does not exist')) {
        console.error('❌ Photo Storage Error: Storage bucket "photos" does not exist');
        console.error('   SOLUTION: Create the "photos" bucket in Supabase Dashboard:');
        console.error('   1. Go to Storage → New bucket');
        console.error('   2. Name: "photos"');
        console.error('   3. Make it Public');
        console.error('   4. Click Create bucket');
      } else if (error.code === '42501' || errorMessage.includes('row-level security') || errorMessage.includes('violates row-level security policy')) {
        console.error('❌ Photo Storage Error: RLS policy violation');
        console.error('   SOLUTION: Set up storage bucket policies in Supabase SQL Editor');
        console.error('   See SUPABASE_SETUP_INSTRUCTIONS.md for the policy SQL');
      } else {
        console.error('Error uploading photo to storage:', errorMessage);
        console.error('   Error code:', error.code);
        console.error('   Photo ID:', photoId);
        console.error('   User ID:', userId);
      }
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

  // Validate storageUrl
  if (!storageUrl || typeof storageUrl !== 'string' || !storageUrl.trim()) {
    console.warn('Invalid storage URL provided for photo download:', storageUrl);
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
    // Validate photo.uri
    if (!photo.uri || typeof photo.uri !== 'string') {
      console.error('Invalid photo URI:', photo.uri);
      return false;
    }

    // Upload photo to storage
    let storagePath = '';
    let storageUrl = '';

    // Check if photo.uri is already a storage URL
    if (photo.uri && photo.uri.startsWith('http') && photo.uri.includes('supabase.co')) {
      // Already uploaded, extract path from URL
      storageUrl = photo.uri;
      const urlParts = photo.uri.split('/');
      const pathIndex = urlParts.findIndex(part => part === 'photos');
      if (pathIndex !== -1) {
        storagePath = urlParts.slice(pathIndex).join('/');
      }
    } else if (photo.uri && !photo.uri.startsWith('http')) {
      // Only upload if it's a local file path (not already a URL)
      // Skip upload if file doesn't exist (old temporary files)
      const uploadResult = await uploadPhotoToStorage(userId, photo.id, photo.uri);
      if (!uploadResult) {
        // If upload fails (e.g., file doesn't exist), but photo already has books,
        // we can still save the metadata if it's already in Supabase
        console.warn(`Failed to upload photo ${photo.id} to storage, but continuing with metadata save`);
        // Try to get existing storage info from database
        const { data: existingPhoto } = await supabase
          .from('photos')
          .select('storage_path, storage_url')
          .eq('id', photo.id)
          .single();
        
        if (existingPhoto?.storage_path && existingPhoto?.storage_url) {
          storagePath = existingPhoto.storage_path;
          storageUrl = existingPhoto.storage_url;
        } else {
          // No existing storage info and upload failed - skip saving
          console.error(`❌ Cannot save photo ${photo.id}: no storage path and upload failed`);
          console.error('   This usually means:');
          console.error('   1. The storage bucket "photos" does not exist');
          console.error('   2. Storage bucket RLS policies are not set up');
          console.error('   3. The photo file does not exist locally');
          console.error('   SOLUTION: Check SUPABASE_SETUP_INSTRUCTIONS.md for storage setup');
          return false;
        }
      } else {
        storagePath = uploadResult.storagePath;
        storageUrl = uploadResult.storageUrl;
      }
    } else {
      // Photo has no valid URI - skip saving
      console.warn(`Photo ${photo.id} has no valid URI, skipping save`);
      return false;
    }

    // Save photo metadata to database
    // Note: If you get "Could not find the 'storage_path' column" error,
    // you need to run the migration: supabase-migration-add-photos-table.sql
    const photoData: any = {
      id: photo.id,
      user_id: userId,
      storage_path: storagePath,
      storage_url: storageUrl,
      books: photo.books,
      timestamp: photo.timestamp,
      caption: photo.caption || null,
      updated_at: new Date().toISOString(),
    };
    
    // If uri column exists (legacy), set it to storage_url for compatibility
    // The uri column might exist from an older schema
    if (photo.uri) {
      photoData.uri = photo.uri;
    } else if (storageUrl) {
      // Use storage_url as uri if uri column exists but we don't have a local uri
      photoData.uri = storageUrl;
    }
    
    const { error } = await supabase
      .from('photos')
      .upsert(photoData, {
        onConflict: 'id',
      });

    if (error) {
      const errorMessage = error?.message || error?.code || JSON.stringify(error) || String(error);
      console.error('Error saving photo to database:', errorMessage);
      
      // If the error is about missing column, provide helpful message
      if (errorMessage.includes('storage_path') || errorMessage.includes('column')) {
        console.error('⚠️ Database schema issue: The photos table may be missing columns.');
        console.error('⚠️ Please run the migration: supabase-migration-add-photos-table.sql');
      }
      
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
    // OPTIMIZATION: Don't download photos immediately - use cloud URLs directly
    // Photos will be cached lazily when viewed
    // Only include photos with valid storage URLs (already uploaded to Supabase)
    // Filter out photos with only local file paths (those are temporary and shouldn't be loaded)
    const photos: Photo[] = data
      .filter((row) => {
        // Only include photos that have a valid storage URL (already uploaded to Supabase)
        // Filter out photos with only local file paths (those are temporary and shouldn't be loaded)
        const hasStorageUrl = row.storage_url && typeof row.storage_url === 'string' && row.storage_url.startsWith('http');
        if (!hasStorageUrl) {
          console.warn(`Photo ${row.id} has no valid storage URL, skipping (may be old temporary file)`);
        }
        return hasStorageUrl;
      })
      .map((row) => {
        // Use cloud URL directly for faster loading
        // Photo will be cached when actually viewed
        const photoUri = row.storage_url; // Always use storage_url for loaded photos
        return {
          id: row.id,
          uri: photoUri, // Use cloud URL directly
          books: (row.books || []) as Book[],
          timestamp: row.timestamp,
          caption: row.caption || undefined,
        };
      });

    // OPTIMIZATION: Download photos in background (non-blocking)
    // Only download if they're not already cached and have valid URLs
    Promise.all(
      data
        .filter((row) => row.storage_url && typeof row.storage_url === 'string') // Only process valid URLs
        .map(async (row) => {
          try {
            // Check if already cached
            if (!FileSystem.documentDirectory) return;
            const cachePath = `${FileSystem.documentDirectory}photos/${row.id}.jpg`;
            const fileInfo = await FileSystem.getInfoAsync(cachePath);
            if (!fileInfo.exists && row.storage_url) {
              // Download in background (don't await)
              downloadPhotoFromStorage(row.storage_url, row.id).catch(() => {
                // Silently fail - will retry when photo is viewed
              });
            }
          } catch (error) {
            // Ignore errors - photo will load from cloud URL
          }
        })
    ).catch(() => {
      // Ignore background download errors
    });

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
    // CRITICAL: Verify user session before attempting to save
    // RLS policies require auth.uid() to match user_id
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    
    if (sessionError || !sessionData?.session) {
      console.error('❌ No Supabase session found. User must be authenticated to save books.');
      console.error('   Session error:', sessionError?.message || 'No session');
      console.error('   Attempted user_id:', userId);
      return false;
    }

    const authenticatedUserId = sessionData.session.user.id;
    if (authenticatedUserId !== userId) {
      console.error('❌ User ID mismatch! Authenticated user does not match book user_id.');
      console.error('   Authenticated user:', authenticatedUserId);
      console.error('   Book user_id:', userId);
      console.error('   This violates RLS policies. Book will not be saved.');
      return false;
    }
    // Convert scannedAt to BIGINT (timestamp in milliseconds) for Supabase
    // scanned_at is BIGINT in database, not TIMESTAMPTZ
    const scannedAtValue = book.scannedAt 
      ? (typeof book.scannedAt === 'number' ? book.scannedAt : new Date(book.scannedAt).getTime())
      : null;

    const bookData = {
      user_id: userId,
      title: book.title,
      author: book.author || null,
      isbn: book.isbn || null,
      confidence: book.confidence || null,
      status: status,
      scanned_at: scannedAtValue, // BIGINT timestamp in milliseconds
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
    // First try to find existing book to avoid duplicate key errors
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
      const errorMessage = findError?.message || findError?.code || JSON.stringify(findError) || String(findError);
      const isAbortError = errorMessage.includes('AbortError') || errorMessage.includes('Aborted') || 
                          (findError as any)?.name === 'AbortError' || 
                          (findError as any)?.constructor?.name === 'AbortError';
      
      if (isAbortError) {
        console.warn('⚠️ Book lookup aborted (likely timeout):', book.title);
        // Don't log full error for abort errors to reduce noise
      } else {
        console.warn('Error finding book in Supabase:', findError);
      }
    }

    if (existingBook) {
      // Update existing book
      const { error: updateError } = await supabase
        .from('books')
        .update(bookData)
        .eq('id', existingBook.id);

      if (updateError) {
        // Check if error is an AbortError (request was cancelled/timed out)
        const errorMessage = updateError?.message || updateError?.code || JSON.stringify(updateError) || String(updateError);
        const isAbortError = errorMessage.includes('AbortError') || errorMessage.includes('Aborted') || 
                            (updateError as any)?.name === 'AbortError' || 
                            (updateError as any)?.constructor?.name === 'AbortError';
        // Check for HTML error pages (Supabase service issues)
        const isHtmlError = typeof errorMessage === 'string' && (
          errorMessage.trim().startsWith('<!DOCTYPE') ||
          errorMessage.trim().startsWith('<html') ||
          errorMessage.includes('Cloudflare') ||
          errorMessage.includes('502 Bad Gateway') ||
          errorMessage.includes('503 Service Unavailable') ||
          errorMessage.includes('504 Gateway Timeout')
        );
        const isDateRangeError = typeof errorMessage === 'string' && errorMessage.includes('date/time field value out of range');
        
        if (isAbortError) {
          console.warn('⚠️ Book update aborted (likely timeout or network issue):', book.title);
          console.warn('   This is usually temporary - the book may sync on next attempt');
          return false;
        } else if (isHtmlError) {
          console.warn('⚠️ Supabase service error (HTML response):', book.title);
          console.warn('   This is usually a temporary Supabase/Cloudflare issue');
          console.warn('   The book will be retried on next sync attempt');
          // Don't log full error details for HTML errors to reduce noise
          return false;
        } else if (isDateRangeError) {
          console.error('❌ Error updating book in Supabase: Date/time field value out of range');
          console.error('   This indicates scanned_at column is TIMESTAMPTZ but we sent BIGINT');
          console.error('   SOLUTION: Run the migration supabase-migration-fix-scanned-at-type.sql');
          console.error('   Book title:', book.title);
          console.error('   scanned_at value:', bookData.scanned_at);
          // Don't log full book data for this error to reduce noise
        } else {
          console.error('Error updating book in Supabase:', errorMessage);
          console.error('Book data:', JSON.stringify(bookData, null, 2));
        }
        return false;
      }
    } else {
      // Insert new book - catch duplicate key errors and retry as update
      const { error: insertError } = await supabase
        .from('books')
        .insert(bookData);

      if (insertError) {
        // If we get a duplicate key error, the book exists but our query didn't find it
        // (could be due to race condition or case sensitivity issues)
        // Try to find and update it
        if (insertError.code === '23505' || insertError.message?.includes('duplicate key') || insertError.message?.includes('idx_books_user_title_author_unique')) {
          console.warn('Duplicate key error on insert, attempting to find and update existing book...');
          
          const { data: existingBookRetry, error: findErrorRetry } = await supabase
            .from('books')
            .select('id')
            .eq('user_id', userId)
            .eq('title', book.title)
            .eq('author', authorForQuery)
            .maybeSingle();

          if (findErrorRetry && findErrorRetry.code !== 'PGRST116') {
            const errorMessage = findErrorRetry?.message || findErrorRetry?.code || JSON.stringify(findErrorRetry) || String(findErrorRetry);
            const isAbortError = errorMessage.includes('AbortError') || errorMessage.includes('Aborted') || 
                                (findErrorRetry as any)?.name === 'AbortError' || 
                                (findErrorRetry as any)?.constructor?.name === 'AbortError';
            
            if (isAbortError) {
              console.warn('⚠️ Book lookup aborted after duplicate key error (likely timeout):', book.title);
            } else {
              console.error('Error finding existing book after duplicate key error:', errorMessage);
            }
            return false;
          }

          if (existingBookRetry) {
            // Update existing book
            const { error: updateErrorRetry } = await supabase
              .from('books')
              .update(bookData)
              .eq('id', existingBookRetry.id);

            if (updateErrorRetry) {
              const errorMessage = updateErrorRetry?.message || updateErrorRetry?.code || JSON.stringify(updateErrorRetry) || String(updateErrorRetry);
              const isAbortError = errorMessage.includes('AbortError') || errorMessage.includes('Aborted') || 
                                  (updateErrorRetry as any)?.name === 'AbortError' || 
                                  (updateErrorRetry as any)?.constructor?.name === 'AbortError';
              
              if (isAbortError) {
                console.warn('⚠️ Book update aborted after duplicate key retry (likely timeout):', book.title);
                console.warn('   This is usually temporary - the book may sync on next attempt');
              } else {
                console.error('Error updating book after duplicate key error:', errorMessage);
                console.error('Book data:', JSON.stringify(bookData, null, 2));
              }
              return false;
            }
            return true;
          }
        }
        
        const errorMessage = insertError?.message || insertError?.code || JSON.stringify(insertError) || String(insertError);
        const isHtmlError = typeof errorMessage === 'string' && errorMessage.trim().startsWith('<!DOCTYPE');
        const isDateRangeError = typeof errorMessage === 'string' && errorMessage.includes('date/time field value out of range');
        
        if (isHtmlError) {
          console.error('❌ Error inserting book to Supabase: Received HTML error page (likely Cloudflare 500 error)');
          console.error('   This usually indicates a database schema mismatch or server issue');
          console.error('   Error code:', insertError?.code);
          console.error('   Book title:', book.title);
          console.error('   scanned_at value type:', typeof bookData.scanned_at, 'value:', bookData.scanned_at);
        } else if (isDateRangeError) {
          console.error('❌ Error inserting book to Supabase: Date/time field value out of range');
          console.error('   This indicates scanned_at column is TIMESTAMPTZ but we sent BIGINT');
          console.error('   SOLUTION: Run the migration supabase-migration-fix-scanned-at-type.sql');
          console.error('   Book title:', book.title);
          console.error('   scanned_at value:', bookData.scanned_at);
          // Don't log full book data for this error to reduce noise
        } else if (insertError.code === '42501' || errorMessage.includes('row-level security') || errorMessage.includes('violates row-level security policy')) {
          console.error('❌ RLS Policy Violation: Cannot insert book - row-level security policy violation');
          console.error('   This usually means:');
          console.error('   1. The user session is invalid or expired');
          console.error('   2. The user_id does not match auth.uid()');
          console.error('   3. RLS policies are not set up correctly in Supabase');
          console.error('   Authenticated user:', authenticatedUserId);
          console.error('   Book user_id:', userId);
          console.error('   Book title:', book.title);
          console.error('   SOLUTION: Ensure user is properly authenticated and RLS policies allow inserts');
        } else {
          console.error('Error inserting book to Supabase:', errorMessage);
          console.error('Book data:', JSON.stringify(bookData, null, 2));
        }
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
    // Fetch ALL books for the user (no limit - users should be able to have unlimited books)
    // Add index on user_id + scanned_at for better performance
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
    // Use the database UUID as the ID to ensure uniqueness
    const books: Book[] = data.map((row) => ({
      id: row.id || `${row.title}_${row.author || ''}_${row.scanned_at || Date.now()}`,
      title: row.title,
      author: row.author || undefined,
      isbn: row.isbn || undefined,
      confidence: row.confidence || undefined,
      status: row.status || 'pending',
      // scanned_at is BIGINT in database, ensure it's a number or undefined
      scannedAt: row.scanned_at != null ? Number(row.scanned_at) : undefined,
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
      readAt: row.read_at ? (typeof row.read_at === 'number' ? row.read_at : (typeof row.read_at === 'string' ? parseInt(row.read_at, 10) : new Date(row.read_at).getTime())) : undefined, // Map read_at from Supabase to readAt in Book (BIGINT -> number)
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
      // Don't log full error object, just the message to reduce noise
      const errorMsg = fetchError?.message || fetchError?.code || 'Unknown error';
      console.warn(`⚠️ Error fetching photo ${photoId} for deletion: ${errorMsg}`);
      // Continue with deletion even if fetch fails - the photo might not exist in Supabase
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

