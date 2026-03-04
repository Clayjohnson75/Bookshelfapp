import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronBackIcon, CheckmarkCircleIcon, FolderIcon } from '../components/Icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../theme/ThemeProvider';
import { useAuth } from '../auth/SimpleAuthContext';
import type { Folder } from '../types/BookTypes';
import {
  invokeSelectCollectionCallback,
  clearSelectCollectionCallback,
} from '../lib/selectCollectionCallbacks';

export type SelectCollectionParams = {
  /** Opaque callback ID registered via registerSelectCollectionCallback. Serializable (no function in params). */
  callbackId: string;
};

export function SelectCollectionScreen() {
  const route = useRoute();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { t } = useTheme();
  const { user } = useAuth();
  const { callbackId } = route.params as SelectCollectionParams;

  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  const foldersKey = user ? `folders_${user.uid}` : null;

  useEffect(() => {
    if (!foldersKey) return;
    AsyncStorage.getItem(foldersKey).then((raw) => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        setFolders(Array.isArray(parsed) ? parsed : []);
      } catch { /* ignore */ }
    });
  }, [foldersKey]);

  const saveFolders = useCallback(async (updated: Folder[]) => {
    if (!foldersKey) return;
    setFolders(updated);
    await AsyncStorage.setItem(foldersKey, JSON.stringify(updated));
  }, [foldersKey]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    const newFolder: Folder = {
      id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      bookIds: [],
      photoIds: [],
      createdAt: Date.now(),
    };
    const updated = [...folders, newFolder];
    await saveFolders(updated);
    setNewName('');
    setSelectedId(newFolder.id);
  }, [newName, folders, saveFolders]);

  const handleConfirm = useCallback(() => {
    invokeSelectCollectionCallback(callbackId, selectedId);
    clearSelectCollectionCallback(callbackId);
    navigation.goBack();
  }, [callbackId, selectedId, navigation]);

  const handleSkip = useCallback(() => {
    invokeSelectCollectionCallback(callbackId, null);
    clearSelectCollectionCallback(callbackId);
    navigation.goBack();
  }, [callbackId, navigation]);

  const handleBack = useCallback(() => {
    // Back without selection — clear the callback to avoid a leak.
    clearSelectCollectionCallback(callbackId);
    navigation.goBack();
  }, [callbackId, navigation]);

  const s = getStyles(t);

  return (
    <SafeAreaView style={[s.container, { backgroundColor: t.colors.bg }]} edges={['left', 'right', 'bottom']}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 12, borderBottomColor: t.colors.divider ?? t.colors.border }]}>
        <TouchableOpacity
          onPress={handleBack}
          style={s.headerBack}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <ChevronBackIcon size={22} color={t.colors.primary} />
          <Text style={[s.headerBackText, { color: t.colors.primary }]}>Back</Text>
        </TouchableOpacity>
        <View style={s.headerTitleWrap} pointerEvents="none">
          <Text style={[s.headerTitle, { color: t.colors.text }]}>Add to Collection</Text>
        </View>
        {/* right spacer keeps title centred */}
        <View style={s.headerBack} />
      </View>

      <ScrollView
        style={s.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {/* Create new collection */}
        <View style={[s.card, { backgroundColor: t.colors.surface }]}>
          <Text style={[s.sectionTitle, { color: t.colors.text }]}>Create New Collection</Text>
          <View style={s.createRow}>
            <TextInput
              style={[s.createInput, { backgroundColor: t.colors.surface2, borderColor: t.colors.border, color: t.colors.text }]}
              value={newName}
              onChangeText={setNewName}
              placeholder="Collection name..."
              placeholderTextColor={t.colors.textMuted}
              autoCapitalize="words"
              autoFocus={folders.length === 0}
              returnKeyType="done"
              onSubmitEditing={handleCreate}
            />
            <TouchableOpacity
              style={[s.createBtn, !newName.trim() && s.createBtnDisabled, { backgroundColor: t.colors.primary }]}
              onPress={handleCreate}
              disabled={!newName.trim()}
              activeOpacity={0.8}
            >
              <Text style={[s.createBtnText, { color: t.colors.primaryText }]}>Create</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Existing collections */}
        {folders.length > 0 && (
          <View style={[s.card, { backgroundColor: t.colors.surface }]}>
            <Text style={[s.sectionTitle, { color: t.colors.text }]}>Select Collection</Text>
            {folders.map((folder) => (
              <TouchableOpacity
                key={folder.id}
                style={[s.folderRow, selectedId === folder.id && { backgroundColor: t.colors.surface2 }]}
                onPress={() => setSelectedId(folder.id)}
                activeOpacity={0.7}
              >
                <FolderIcon
                  size={24}
                  color={selectedId === folder.id ? t.colors.primary : t.colors.muted ?? t.colors.textMuted}
                  style={s.folderIcon}
                />
                <View style={s.folderInfo}>
                  <Text style={[s.folderName, { color: selectedId === folder.id ? t.colors.primary : t.colors.text }]}>
                    {folder.name}
                  </Text>
                  <Text style={[s.folderCount, { color: t.colors.textMuted }]}>
                    {folder.bookIds.length} {folder.bookIds.length === 1 ? 'book' : 'books'}
                  </Text>
                </View>
                {selectedId === folder.id && (
                  <CheckmarkCircleIcon size={24} color={t.colors.primary} />
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Actions */}
        <View style={s.actions}>
          <TouchableOpacity
            style={[s.actionBtn, { backgroundColor: t.colors.surface2 }]}
            onPress={handleSkip}
            activeOpacity={0.8}
          >
            <Text style={[s.skipText, { color: t.colors.textMuted }]}>Skip</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.actionBtn, { backgroundColor: t.colors.primary }, !selectedId && s.actionBtnDisabled]}
            onPress={handleConfirm}
            disabled={!selectedId}
            activeOpacity={0.8}
          >
            <Text style={[s.confirmText, { color: t.colors.primaryText }]}>Continue</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function getStyles(t: import('../theme/tokens').ThemeTokens) {
  return StyleSheet.create({
    container: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    headerBack: {
      flexDirection: 'row',
      alignItems: 'center',
      minWidth: 72,
      paddingHorizontal: 4,
    },
    headerBackText: {
      fontSize: 16,
      fontWeight: '600',
      marginLeft: 2,
    },
    headerTitleWrap: {
      flex: 1,
      alignItems: 'center',
    },
    headerTitle: {
      fontSize: 17,
      fontWeight: '700',
    },
    scroll: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
    card: {
      borderRadius: 16,
      padding: 18,
      marginBottom: 16,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 8,
      elevation: 2,
    },
    sectionTitle: {
      fontSize: 17,
      fontWeight: '700',
      marginBottom: 14,
      letterSpacing: 0.2,
    },
    createRow: {
      flexDirection: 'row',
      gap: 10,
    },
    createInput: {
      flex: 1,
      height: 48,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 14,
      fontSize: 15,
    },
    createBtn: {
      height: 48,
      paddingHorizontal: 18,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    createBtnDisabled: { opacity: 0.45 },
    createBtnText: {
      fontSize: 15,
      fontWeight: '700',
    },
    folderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 10,
      borderRadius: 10,
      marginBottom: 4,
    },
    folderIcon: { marginRight: 12 },
    folderInfo: { flex: 1 },
    folderName: { fontSize: 16, fontWeight: '600' },
    folderCount: { fontSize: 13, marginTop: 2 },
    actions: {
      flexDirection: 'row',
      gap: 12,
      marginTop: 4,
      marginBottom: 8,
    },
    actionBtn: {
      flex: 1,
      height: 52,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionBtnDisabled: { opacity: 0.45 },
    skipText: { fontSize: 16, fontWeight: '700' },
    confirmText: { fontSize: 16, fontWeight: '700' },
  });
}
