import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { AppHeader } from '../components/AppHeader';
import type { Book, Photo } from '../types/BookTypes';

const SAMPLE_BOOK: Book = {
  id: 'theme-qa-book',
  dbId: '11111111-1111-4111-8111-111111111111',
  title: 'The Secret History',
  author: 'Donna Tartt',
  status: 'approved',
  description: 'A sample description used for header consistency QA.',
  publisher: 'Alfred A. Knopf',
  pageCount: 559,
  source_photo_id: 'theme-qa-photo',
};

const SAMPLE_PHOTO: Photo = {
  id: 'theme-qa-photo',
  uri: 'https://images.unsplash.com/photo-1521587760476-6c12a4b040da?w=1200',
  books: [SAMPLE_BOOK],
  timestamp: Date.now(),
};

function QaLink({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <TouchableOpacity
      style={[
        styles.link,
        {
          backgroundColor: t.colors.surface,
          borderColor: t.colors.borderSubtle ?? t.colors.border,
        },
      ]}
      activeOpacity={0.8}
      onPress={onPress}
    >
      <Text style={[styles.linkText, { color: t.colors.textPrimary ?? t.colors.text }]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function ThemeConsistencyTestScreen() {
  const { t } = useTheme();
  const navigation = useNavigation<any>();

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: t.colors.bg }]} edges={['left', 'right', 'bottom']}>
      <AppHeader title="Theme Consistency QA" onBack={() => navigation.navigate('Scans')} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.sectionTitle, { color: t.colors.textPrimary ?? t.colors.text }]}>Primary Screens</Text>
        <QaLink label="Scans Tab" onPress={() => navigation.navigate('Scans')} />
        <QaLink label="Explore Tab" onPress={() => navigation.navigate('Explore')} />
        <QaLink label="My Library Tab" onPress={() => navigation.navigate('MyLibrary')} />

        <Text style={[styles.sectionTitle, { color: t.colors.textPrimary ?? t.colors.text }]}>Nested Header Screens</Text>
        <QaLink
          label="Add Caption (ScansStack)"
          onPress={() =>
            navigation.navigate('Scans', {
              screen: 'AddCaption',
              params: {
                pendingImages: [{ uri: SAMPLE_PHOTO.uri, scanId: 'theme-qa-scan' }],
                initialIndex: 0,
                initialCaption: 'Theme QA',
              },
            })
          }
        />
        <QaLink
          label="Book Details (ScansStack)"
          onPress={() =>
            navigation.navigate('Scans', {
              screen: 'BookDetail',
              params: { book: SAMPLE_BOOK, photo: SAMPLE_PHOTO },
            })
          }
        />
        <QaLink
          label="Photo Details (LibraryStack)"
          onPress={() =>
            navigation.navigate('MyLibrary', {
              screen: 'PhotoDetail',
              params: { photoId: SAMPLE_PHOTO.id, photo: SAMPLE_PHOTO },
            })
          }
        />
        <QaLink
          label="Book Details (LibraryStack)"
          onPress={() =>
            navigation.navigate('MyLibrary', {
              screen: 'BookDetail',
              params: { book: SAMPLE_BOOK, photo: SAMPLE_PHOTO },
            })
          }
        />

        <Text style={[styles.sectionTitle, { color: t.colors.textPrimary ?? t.colors.text }]}>Manual Modal Checks</Text>
        <View style={[styles.note, { backgroundColor: t.colors.surface2, borderColor: t.colors.border }]}>
          <Text style={[styles.noteText, { color: t.colors.textSecondary ?? t.colors.textMuted }]}>
            Open from My Library: Settings, Upgrade, Login/Auth gate, User Profile, Sort/Select modals.
          </Text>
          <Text style={[styles.noteText, { color: t.colors.textSecondary ?? t.colors.textMuted }]}>
            Verify: header background token, title typography, icon button sizing, divider behavior, and safe-area spacing.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { padding: 16, paddingBottom: 28 },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginTop: 8, marginBottom: 10 },
  link: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  linkText: { fontSize: 15, fontWeight: '600' },
  note: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  noteText: { fontSize: 13, lineHeight: 18 },
});

