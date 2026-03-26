import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
 View,
 Text,
 StyleSheet,
 TouchableOpacity,
 Image,
 TextInput,
 ScrollView,
 Keyboard,
 InteractionManager,
} from 'react-native';
import { useRoute, useNavigation, StackActions } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronBackIcon, ArrowBackIcon, ArrowForwardIcon, FolderIcon, TrashIcon } from '../components/Icons';
import { useTheme } from '../theme/ThemeProvider';
import { useResponsive } from '../lib/useResponsive';
import { clearAddCaptionCallbacks, getAddCaptionCallbacks } from '../lib/addCaptionCallbacks';

export type AddCaptionParams = {
 pendingImages: Array<{ uri: string; scanId: string }>;
 initialIndex: number;
 initialCaption: string;
 callbackId?: string;
};

export function AddCaptionScreen() {
 const route = useRoute();
 const navigation = useNavigation();
 const insets = useSafeAreaInsets();
 const { t } = useTheme();
 const params = route.params as AddCaptionParams;
 const callbacks = getAddCaptionCallbacks(params.callbackId);

 const [currentIndex, setCurrentIndex] = useState(params.initialIndex);
 const [captionText, setCaptionText] = useState(params.initialCaption);
 const [deletedScanIds, setDeletedScanIds] = useState<Set<string>>(new Set());

 // Filter out deleted photos — params are immutable in React Navigation
 const pendingImages = params.pendingImages.filter(img => !deletedScanIds.has(img.scanId));
 const currentImage = pendingImages[currentIndex];
 const isLast = currentIndex >= pendingImages.length - 1;

 const handleBack = useCallback(() => {
 Keyboard.dismiss();
 navigation.dispatch(StackActions.popToTop());
 }, [navigation]);

 const handleSkip = useCallback(async () => {
 Keyboard.dismiss();
 if (isLast) {
 try { await callbacks?.onSkip(); } catch (_) { /* upload continues in background */ }
 clearAddCaptionCallbacks(params.callbackId);
 navigation.dispatch(StackActions.popToTop());
 } else {
 setCurrentIndex((i) => i + 1);
 setCaptionText('');
 }
 }, [isLast, callbacks, params.callbackId, navigation]);

 const handleSubmit = useCallback(async () => {
 if (!currentImage) return;
 Keyboard.dismiss();
 const caption = captionText.trim();
 // Wrap in try/catch so an onSubmit error never silently swallows the navigation.
 // The upload starts in the background inside onSubmit; we always navigate regardless.
 try {
 await callbacks?.onSubmit(currentImage.scanId, caption, isLast);
 } catch (_) { /* upload continues in background */ }
 if (isLast) {
 clearAddCaptionCallbacks(params.callbackId);
 navigation.dispatch(StackActions.popToTop());
 } else {
 setCurrentIndex((i) => i + 1);
 setCaptionText('');
 }
 }, [currentImage, captionText, isLast, callbacks, params.callbackId, navigation]);

 const handleAddToFolder = useCallback(async () => {
 Keyboard.dismiss();
 await callbacks?.onAddToFolder();
 }, [callbacks]);

 const handleDelete = useCallback(async () => {
 if (!currentImage) return;
 Keyboard.dismiss();
 const scanId = currentImage.scanId;
 // Call parent to remove from batch state
 try { await callbacks?.onDelete?.(scanId); } catch {}
 // Track locally so the photo disappears from our filtered list
 setDeletedScanIds(prev => new Set(prev).add(scanId));
 // If this was the last remaining photo, go back
 const remainingAfterDelete = params.pendingImages.filter(
   img => !deletedScanIds.has(img.scanId) && img.scanId !== scanId
 );
 if (remainingAfterDelete.length === 0) {
   clearAddCaptionCallbacks(params.callbackId);
   navigation.dispatch(StackActions.popToTop());
   return;
 }
 // If we're past the end after deletion, step back
 if (currentIndex >= remainingAfterDelete.length) {
   setCurrentIndex(remainingAfterDelete.length - 1);
 }
 setCaptionText('');
 }, [currentImage, callbacks, params.pendingImages, params.callbackId, deletedScanIds, currentIndex, navigation]);

 useEffect(() => {
 return () => {
 clearAddCaptionCallbacks(params.callbackId);
 };
 }, [params.callbackId]);

 // Guard: if there is no current image (e.g. params.pendingImages was empty or
 // currentIndex went out of range), leave screen. Must run in useEffect — calling
 // navigation during render triggers "Cannot update a component while
 // rendering a different component" and can destabilize the entire navigation stack.
 useEffect(() => {
 if (!currentImage) {
   navigation.dispatch(StackActions.popToTop());
 }
 }, [currentImage, navigation]);

 if (!currentImage) {
 return null;
 }

 const headerHeight = insets.top + 48;
 const { screenWidth } = useResponsive();
 const styles = useMemo(() => getStyles(t, screenWidth), [t, screenWidth]);

 return (
 <SafeAreaView style={[styles.container, { backgroundColor: t.colors.bg }]} edges={['left', 'right']}>
 {/* Header */}
 <View
 style={[
 styles.header,
 {
 height: headerHeight,
 paddingTop: insets.top,
 backgroundColor: t.colors.headerBg ?? t.colors.headerBackground ?? t.colors.surface ?? t.colors.bg,
 borderBottomColor: t.colors.divider ?? t.colors.separator ?? t.colors.border,
 },
 ]}
 >
 <View style={styles.headerRow}>
 <TouchableOpacity
 onPress={handleBack}
 style={styles.headerSide}
 hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
 >
 <ChevronBackIcon size={22} color={t.colors.headerIcon ?? t.colors.text} />
 </TouchableOpacity>
 <View style={styles.headerTitleWrap} pointerEvents="none">
 <Text style={[styles.headerTitle, { color: t.colors.headerText ?? t.colors.text }]}>
 {pendingImages.length > 1
 ? `Add Caption (${currentIndex + 1}/${pendingImages.length})`
 : 'Add Caption'}
 </Text>
 </View>
 <TouchableOpacity
 onPress={handleSkip}
 style={styles.headerSide}
 hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
 >
 <Text style={[styles.headerSkipText, { color: t.colors.primary }]}>
 {isLast ? 'Skip All' : 'Skip'}
 </Text>
 </TouchableOpacity>
 </View>
 </View>

 {/* Photo Action row Caption. ScrollView scrolls content above keyboard; no KAV needed. */}
 <ScrollView
 style={styles.flex1}
 keyboardShouldPersistTaps="handled"
 keyboardDismissMode="on-drag"
 showsVerticalScrollIndicator={false}
 contentContainerStyle={[
 styles.scrollContent,
 { paddingBottom: insets.bottom + 24 },
 ]}
 >
 {/* Photo */}
 <Image
 source={{ uri: currentImage.uri }}
 style={styles.photo}
 resizeMode="cover"
 fadeDuration={0}
 />

 {/* Swipe hint */}
 {pendingImages.length > 1 && (
 <View style={[styles.swipeHint, { backgroundColor: t.colors.surface2 }]}>
 <ArrowBackIcon size={16} color={t.colors.muted} />
 <Text style={[styles.swipeHintText, { color: t.colors.textMuted }]}>
 Swipe left/right to navigate {currentIndex + 1} of {pendingImages.length}
 </Text>
 <ArrowForwardIcon size={16} color={t.colors.muted} />
 </View>
 )}

 {/* Action row: Delete + Add to Collection + Next/Done */}
 <View style={styles.actionRow}>
 {pendingImages.length > 0 && (
 <TouchableOpacity
   style={[styles.deleteButton, { borderColor: '#D94040' }]}
   onPress={handleDelete}
   activeOpacity={0.7}
   hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
 >
   <TrashIcon size={20} color="#D94040" />
 </TouchableOpacity>
 )}
 <TouchableOpacity
 style={[styles.folderButton, { borderColor: t.colors.primary }]}
 onPress={handleAddToFolder}
 activeOpacity={0.8}
 >
 <FolderIcon size={20} color={t.colors.primary} style={styles.folderIcon} />
 <Text style={[styles.folderButtonText, { color: t.colors.primary }]}>Add to Collection</Text>
 </TouchableOpacity>
 <TouchableOpacity
 style={[styles.submitButton, { backgroundColor: t.colors.primary }]}
 onPress={handleSubmit}
 activeOpacity={0.8}
 >
 <Text style={styles.submitButtonText}>{isLast ? 'Done' : 'Next'}</Text>
 </TouchableOpacity>
 </View>

 {/* Caption card */}
 <View style={[styles.captionCard, { backgroundColor: t.colors.surface, borderColor: t.colors.border }]}>
 <Text style={[styles.captionLabel, { color: t.colors.textMuted }]}>Caption / Location</Text>
 <TextInput
 style={[styles.captionInput, { color: t.colors.text }]}
 value={captionText}
 onChangeText={setCaptionText}
 placeholder="e.g. Living Room Bookshelf, Office"
 placeholderTextColor={t.colors.textMuted}
 multiline
 autoFocus={currentIndex === 0}
 returnKeyType={isLast ? 'done' : 'next'}
 textAlignVertical="top"
 onSubmitEditing={() => {
 Keyboard.dismiss();
 handleSubmit();
 }}
 />
 </View>
 </ScrollView>
 </SafeAreaView>
 );
}

function getStyles(t: import('../theme/tokens').ThemeTokens, screenWidth: number) {
 return StyleSheet.create({
 flex1: {
 flex: 1,
 },
 container: {
 flex: 1,
 },
 header: {
 borderBottomWidth: StyleSheet.hairlineWidth,
 paddingHorizontal: 10,
 justifyContent: 'flex-end',
 },
 headerRow: {
 minHeight: 40,
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'space-between',
 position: 'relative',
 },
 headerTitleWrap: {
 ...StyleSheet.absoluteFillObject,
 alignItems: 'center',
 justifyContent: 'center',
 paddingHorizontal: 88,
 },
 headerTitle: {
 fontSize: 16,
 fontWeight: '600',
 },
 headerSide: {
 minWidth: 44,
 minHeight: 40,
 alignItems: 'center',
 justifyContent: 'center',
 },
 headerSkipText: {
 fontSize: 15,
 fontWeight: '600',
 },
 scrollContent: {
 paddingHorizontal: 16,
 paddingTop: 12,
 gap: 12,
 },
 photo: {
 width: '100%',
 height: Math.round(Math.min(280, Math.max(180, screenWidth * 0.56))),
 borderRadius: 18,
 backgroundColor: t.colors.surface2,
 },
 swipeHint: {
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 paddingVertical: 6,
 paddingHorizontal: 12,
 borderRadius: 8,
 gap: 8,
 },
 swipeHintText: {
 fontSize: 12,
 fontWeight: '500',
 },
 /** Action row: Delete (circle) + Add to Collection (flex 1) + Next/Done (fixed width). */
 actionRow: {
 flexDirection: 'row',
 alignItems: 'center',
 gap: 10,
 },
 deleteButton: {
 width: 52,
 height: 52,
 borderRadius: 14,
 borderWidth: 2,
 alignItems: 'center',
 justifyContent: 'center',
 },
 folderButton: {
 flex: 1,
 height: 52,
 paddingHorizontal: 18,
 borderRadius: 14,
 flexDirection: 'row',
 alignItems: 'center',
 justifyContent: 'center',
 borderWidth: 2,
 },
 folderIcon: {
 marginRight: 8,
 },
 folderButtonText: {
 fontSize: 15,
 fontWeight: '700',
 },
 submitButton: {
 width: 120,
 height: 52,
 borderRadius: 14,
 alignItems: 'center',
 justifyContent: 'center',
 },
 submitButtonText: {
 color: '#FFFFFF',
 fontSize: 16,
 fontWeight: '700',
 },
 /** Caption card with input. */
 captionCard: {
 borderRadius: 18,
 padding: 14,
 borderWidth: 0.5,
 },
 captionLabel: {
 fontSize: 13,
 fontWeight: '700',
 marginBottom: 10,
 opacity: 0.6,
 },
 captionInput: {
 fontSize: 16,
 minHeight: 96,
 textAlignVertical: 'top',
 },
 });
}
