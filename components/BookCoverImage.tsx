/**
 * Renders a book cover using signed URL when coverUrl is a storage path (photos bucket).
 * Falls back to a title-text cover never renders a blank placeholder.
 */
import React, { useState } from 'react';
import { Image, View, Text, StyleSheet, ImageStyle, ViewStyle } from 'react-native';
import { useSignedBookCoverUri } from '../hooks/useSignedBookCoverUri';
import type { Book } from '../types/BookTypes';

type Props = {
 book: Book | null | undefined;
 style?: ImageStyle | (ImageStyle | null)[];
 placeholderStyle?: ViewStyle;
 resizeMode?: 'cover' | 'contain' | 'stretch' | 'repeat' | 'center';
 onError?: (e: any) => void;
};

export function BookCoverImage({ book, style, placeholderStyle, resizeMode = 'cover', onError }: Props) {
 const [coverFailed, setCoverFailed] = useState(false);
 const [uri, loading] = useSignedBookCoverUri(book);

 const hasUri = !!uri && !coverFailed;

 if (hasUri) {
 return (
 <Image
 source={{ uri }}
 style={style}
 resizeMode={resizeMode}
 onError={(e) => {
 setCoverFailed(true);
 onError?.(e);
 }}
 />
 );
 }

 // While a signed URL is still resolving, show a silent loading placeholder
 // that matches the frame dimensions so layout doesn't shift.
 if (loading) {
 return <View style={[StyleSheet.flatten(style) as ViewStyle, styles.loading, placeholderStyle]} />;
 }

 // No cover (or load failed): title-only placeholder (author appears below the cover elsewhere)
 const title = book?.title || 'Untitled';

 return (
 <View style={[StyleSheet.flatten(style) as ViewStyle, styles.textCover, placeholderStyle]}>
 <Text numberOfLines={3} ellipsizeMode="tail" style={styles.textCoverTitle}>
 {title}
 </Text>
 </View>
 );
}

const styles = StyleSheet.create({
 loading: {
 backgroundColor: '#e5e7eb',
 },
 textCover: {
 justifyContent: 'center',
 alignItems: 'center',
 padding: 8,
 backgroundColor: '#e5e7eb',
 borderWidth: 0.5,
 borderColor: '#d1d5db',
 },
 textCoverTitle: {
 fontSize: 12,
 fontWeight: '700',
 color: '#374151',
 textAlign: 'center',
 lineHeight: 15,
 },
});
