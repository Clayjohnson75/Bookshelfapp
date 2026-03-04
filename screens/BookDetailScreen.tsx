import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { InteractionManager } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BookDetailModal from '../components/BookDetailModal';
import { Book, Photo } from '../types/BookTypes';
import { useTheme } from '../theme/ThemeProvider';
import { useAuth } from '../auth/SimpleAuthContext';

type BookDetailParams = {
  book?: Book;
  photo?: Photo | null;
  bookId?: string;
};

export function BookDetailScreen() {
  const route = useRoute();
  const navigation = useNavigation();
  const { t } = useTheme();
  const { user } = useAuth();
  const params = (route.params ?? {}) as BookDetailParams;
  const [book, setBook] = useState<Book | null>(null);
  const [photo, setPhoto] = useState<Photo | null>(params.photo ?? null);
  const [loadingBook, setLoadingBook] = useState(true);

  useEffect(() => {
    setPhoto(params.photo ?? null);
  }, [params.photo]);

  useEffect(() => {
    let cancelled = false;
    const requestedBookId = params.bookId ?? params.book?.dbId ?? params.book?.id ?? null;
    setLoadingBook(true);
    setBook(null);

    const interactionTask = InteractionManager.runAfterInteractions(async () => {
      if (cancelled) return;
      try {
        if (!requestedBookId || !user?.uid) {
          setBook(params.book ?? null);
          return;
        }
        const approvedJson = await AsyncStorage.getItem(`approved_books_${user.uid}`);
        if (cancelled) return;
        const approvedBooks: Book[] = approvedJson ? JSON.parse(approvedJson) : [];
        const found = approvedBooks.find((b) => (b.dbId ?? b.id) === requestedBookId);
        setBook(found ?? params.book ?? null);
      } catch {
        setBook(params.book ?? null);
      } finally {
        if (!cancelled) setLoadingBook(false);
      }
    });

    return () => {
      cancelled = true;
      interactionTask.cancel?.();
    };
  }, [params.book, params.bookId, user?.uid]);

  if (loadingBook) {
    return (
      <View style={{ flex: 1, backgroundColor: t.colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={t.colors.primary} />
      </View>
    );
  }

  if (!book) {
    return <View style={{ flex: 1, backgroundColor: t.colors.bg }} />;
  }

  return (
    <BookDetailModal
      visible={true}
      book={book}
      photo={photo}
      onClose={() => navigation.goBack()}
      onBookUpdate={(updatedBook) => setBook(updatedBook)}
      onEditBook={(updatedBook) => setBook(updatedBook)}
    />
  );
}

