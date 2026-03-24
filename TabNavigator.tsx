import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Text, Platform, Pressable } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { logger } from './utils/logger';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { CardStyleInterpolators, TransitionSpecs, createStackNavigator } from '@react-navigation/stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScansTab } from './tabs/ScansTab';
import { CameraIcon } from './components/CameraIcon';
import { CompassIcon } from './components/CompassIcon';
import { AddCaptionScreen } from './screens/AddCaptionScreen';
import { SelectCollectionScreen } from './screens/SelectCollectionScreen';
import { ExploreTab } from './tabs/ExploreTab';
import { MyLibraryTab } from './tabs/MyLibraryTab';
import { PhotoDetailScreen } from './screens/PhotoDetailScreen';
import { BookDetailScreen } from './screens/BookDetailScreen';
import { ScanningNotification } from './components/ScanningNotification';
import { LibraryIcon } from './components/LibraryIcon';
import { useCamera } from './contexts/CameraContext';
import { useScanning } from './contexts/ScanningContext';
import { useBottomDock } from './contexts/BottomDockContext';
import { useTheme } from './theme/ThemeProvider';
import { SUPABASE_REF } from './lib/supabase';
import { getDefaultHeaderOptions } from './lib/headerOptions';

const PhotosScreen = require('./screens/PhotosScreen').default;

/**
 * BottomDock — single absolute container at the screen root that owns all
 * bottom-anchored UI. Layout (bottom → top):
 *   [tab bar]          ← native
 *   [BottomDock]       ← position:absolute, left:0, right:0, bottom:tabBarHeight
 *     [SelectionBar]   ← injected by ScansTab via BottomDockContext (conditional)
 *     [ScanBar]        ← ScanningNotification content (conditional)
 *
 * Use useBottomTabBarHeight() for bottom (already includes safe area on iOS).
 * Only paddingBottom on the bar content should include insets.bottom — not the dock's bottom position.
 */
function BottomDock() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { selectionBarContent, tabBarHeight: contextTabBarHeight } = useBottomDock();
  const { activeScanJobIds, jobsInProgress, failedUploadCount, setScanProgress, cancelGenerationRef } = useScanning();
  const { isCameraActive } = useCamera();
  const { t } = useTheme();

  // BottomDock is a sibling of Tab.Navigator so useBottomTabBarHeight() isn't available here. Use value set by tab screens (ScansTab, MyLibraryTab) or fallback.
  // On iOS the hook often returns height that includes safe area; subtract insets.bottom so the dock sits flush. Then subtract a bit more so the dock overlaps the tab bar slightly and the gap is gone (bar padding keeps content visible).
  const TAB_BAR_INTRINSIC = Platform.OS === 'ios' ? 49 : 56;
  const rawTabBarHeight = contextTabBarHeight > 0 ? contextTabBarHeight : TAB_BAR_INTRINSIC + insets.bottom;
  const baseBottom = Platform.OS === 'ios' ? Math.max(TAB_BAR_INTRINSIC, rawTabBarHeight - insets.bottom) : rawTabBarHeight;
  const dockBottom = Math.max(0, baseBottom - 18);
  const dockContentPaddingBottom = 0;

  // Bar visibility: show when there is real work (don't hide while work is still real).
  // hasUploadWork = local queue has queued/pending/processing items (jobsInProgress from scanQueue + batch).
  // hasScanWork = durable store has active scan job ids (server-assigned); bar stays until server says terminal.
  // Watchdog no longer marks "queued 12s" as error — only marks after 60s and only when no jobId assigned.
  const hasUploadWork = jobsInProgress > 0;
  const hasScanWork = activeScanJobIds.length > 0;
  const hasRecoverableFailures = failedUploadCount > 0;
  const scanBarVisible = !isCameraActive && (hasUploadWork || hasScanWork);
  const failureBannerVisible = !isCameraActive && hasRecoverableFailures && !hasUploadWork && !hasScanWork;

  // Dedupe: show failure banner once per "attempt" (run of failures); dismissable so it doesn't flash on re-render/focus.
  const failureAttemptIdRef = useRef<number | null>(null);
  const [dismissedForAttemptId, setDismissedForAttemptId] = useState<number | null>(null);
  useEffect(() => {
    if (failureBannerVisible) {
      if (failureAttemptIdRef.current === null) failureAttemptIdRef.current = Date.now();
    } else {
      failureAttemptIdRef.current = null;
      setDismissedForAttemptId(null);
    }
  }, [failureBannerVisible]);
  const currentAttemptId = failureAttemptIdRef.current;
  const showFailureBanner = failureBannerVisible && currentAttemptId != null && dismissedForAttemptId !== currentAttemptId;

  const handleDismissFailureBanner = () => {
    if (currentAttemptId != null) setDismissedForAttemptId(currentAttemptId);
  };

  // Failsafe: when no active jobs and no work in progress, clear scan bar UI state.
  useEffect(() => {
    if (activeScanJobIds.length === 0 && jobsInProgress === 0) {
      setScanProgress(null);
    }
  }, [activeScanJobIds.length, jobsInProgress, setScanProgress]);

  // Log only when visibility changes — catches "bar stuck showing" and "bar never showed" bugs.
  const prevScanBarVisibleRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevScanBarVisibleRef.current === scanBarVisible) return;
    const prev = prevScanBarVisibleRef.current;
    prevScanBarVisibleRef.current = scanBarVisible;
    if (prev === null) return; // skip initial mount (no state change yet)
    const reason = scanBarVisible
      ? (hasScanWork ? 'hasScanWork' : 'hasUploadWork')
      : isCameraActive
        ? 'camera_active'
        : failureBannerVisible
          ? 'only_failures_banner'
          : 'no_work';
    logger.cat('[SCAN_BAR_VISIBILITY_CHANGE]', '', {
      visible: scanBarVisible,
      reason,
      hasUploadWork,
      hasScanWork,
      failedUploadCount,
      epoch: cancelGenerationRef.current,
    }, 'debug');
  }, [scanBarVisible, hasUploadWork, hasScanWork, failureBannerVisible, failedUploadCount, isCameraActive, cancelGenerationRef]);

  const hasDockContent = selectionBarContent != null || scanBarVisible || failureBannerVisible;
  if (!hasDockContent) return null;

  const failureLabel =
    failedUploadCount === 1
      ? '1 upload failed — Tap to retry'
      : `${failedUploadCount} uploads failed — Tap to retry`;

  return (
    <View pointerEvents="box-none" style={[styles.bottomDock, { bottom: dockBottom }]}>
      <View style={{ paddingBottom: dockContentPaddingBottom }} pointerEvents="box-none">
        {selectionBarContent}
        {scanBarVisible && <ScanningNotification />}
      {/* Keep banner mounted; animate visibility so no flash. pointerEvents only when visible so it doesn't block buttons. */}
      <View
        style={[
          styles.failureBannerWrap,
          {
            opacity: showFailureBanner ? 1 : 0,
            pointerEvents: showFailureBanner ? 'auto' : 'none',
          },
        ]}
      >
        <Pressable
          onPress={() => navigation.navigate('Scans' as never)}
          style={[styles.failureBanner, { backgroundColor: t.colors.surface2 ?? t.colors.surface, borderColor: t.colors.border }]}
        >
          <Text style={[styles.failureBannerText, { color: t.colors.text }]} numberOfLines={1}>
            {failureLabel}
          </Text>
        </Pressable>
        {showFailureBanner && (
          <Pressable
            onPress={handleDismissFailureBanner}
            hitSlop={8}
            style={styles.failureBannerDismiss}
          >
            <Text style={[styles.failureBannerDismissText, { color: t.colors.textMuted }]}>Dismiss</Text>
          </Pressable>
        )}
      </View>
      </View>
    </View>
  );
}

const Tab = createBottomTabNavigator();
const ScansStack = createStackNavigator();
const ExploreStack = createStackNavigator();
const LibraryStack = createStackNavigator();
const fastDetailTransition = {
 cardStyleInterpolator: CardStyleInterpolators.forHorizontalIOS,
 transitionSpec: {
 open: TransitionSpecs.TransitionIOSSpec,
 close: TransitionSpecs.TransitionIOSSpec,
 },
};

function ScansStackScreen() {
 const { t } = useTheme();
 return (
 <ScansStack.Navigator
 id={undefined}
 screenOptions={{
 ...getDefaultHeaderOptions(t),
 headerTintColor: t.colors.headerIcon ?? t.colors.headerText ?? t.colors.textPrimary ?? t.colors.text,
 }}
 >
 <ScansStack.Screen name="ScansHome" component={ScansTab} />
    <ScansStack.Screen
      name="AddCaption"
      component={AddCaptionScreen}
      options={{
        headerShown: false,
        gestureEnabled: true,
        animationTypeForReplace: 'push',
      }}
    />
    <ScansStack.Screen
      name="SelectCollection"
      component={SelectCollectionScreen}
      options={{
        ...CardStyleInterpolators.forVerticalIOS,
        cardStyleInterpolator: CardStyleInterpolators.forVerticalIOS,
        transitionSpec: {
          open: TransitionSpecs.TransitionIOSSpec,
          close: TransitionSpecs.TransitionIOSSpec,
        },
        headerShown: false,
      }}
    />
    <ScansStack.Screen
      name="BookDetail"
      component={BookDetailScreen}
      options={fastDetailTransition}
    />
 </ScansStack.Navigator>
 );
}

function LibraryStackScreen() {
 const { t } = useTheme();
 return (
 <LibraryStack.Navigator
 id={undefined}
 screenOptions={{
 ...getDefaultHeaderOptions(t),
 headerTintColor: t.colors.headerIcon ?? t.colors.headerText ?? t.colors.textPrimary ?? t.colors.text,
 }}
 >
 <LibraryStack.Screen name="MyLibraryHome" component={MyLibraryTab} />
 <LibraryStack.Screen
 name="Photos"
 component={PhotosScreen}
 options={fastDetailTransition}
 />
 <LibraryStack.Screen
 name="PhotoDetail"
 component={PhotoDetailScreen}
 options={fastDetailTransition}
 />
 <LibraryStack.Screen
 name="BookDetail"
 component={BookDetailScreen}
 options={fastDetailTransition}
 />
 </LibraryStack.Navigator>
 );
}

function ExploreStackScreen() {
 const { t } = useTheme();
 return (
 <ExploreStack.Navigator
 id={undefined}
 screenOptions={{
 ...getDefaultHeaderOptions(t),
 headerTintColor: t.colors.headerIcon ?? t.colors.headerText ?? t.colors.textPrimary ?? t.colors.text,
 }}
 >
 <ExploreStack.Screen name="ExploreRoot" component={ExploreTab} />
 </ExploreStack.Navigator>
 );
}

export const TabNavigator = () => {
 const { isCameraActive } = useCamera();
 const { t } = useTheme();

 return (
 <View style={[styles.container, { backgroundColor: t.colors.bg }]}>
 <Tab.Navigator
 id={undefined}
 initialRouteName="Scans" // Always start on Scans tab (especially for guests)
 screenOptions={{
 // Never fall back to platform default blue.
 tabBarActiveTintColor: t.colors.tabIconActive ?? t.colors.accentPrimary ?? t.colors.accent ?? '#C9A878',
 tabBarInactiveTintColor: t.colors.tabIconInactive ?? t.colors.textMuted ?? t.colors.muted ?? '#7A756D',
 headerShown: false,
 tabBarStyle: isCameraActive ? {
 display: 'none',
 height: 0,
 opacity: 0,
 } : {
 backgroundColor: t.colors.tabBarBg ?? t.colors.navBackground ?? t.colors.surface,
 borderTopWidth: 1,
 borderTopColor: t.colors.tabBarBorderTop ?? t.colors.border,
 elevation: 0,
 shadowOpacity: 0,
 },
 }}
 >
 <Tab.Screen 
 name="Scans" 
 component={ScansStackScreen}
 options={{
 tabBarLabel: 'Scans',
 headerShown: false,
 tabBarIcon: ({ color, size }) => (
 <CameraIcon color={color} size={size} />
 ),
 }}
 />
 <Tab.Screen 
 name="Explore" 
 component={ExploreStackScreen}
 options={{
 tabBarLabel: 'Explore',
 headerShown: false,
 tabBarIcon: ({ color, size }) => (
 <CompassIcon color={color} size={size} />
 ),
 }}
 />
 <Tab.Screen 
 name="MyLibrary" 
 component={LibraryStackScreen}
 options={{
 tabBarLabel: 'My Library',
 headerShown: false,
 tabBarIcon: ({ color, size }) => (
 <LibraryIcon color={color} size={size} />
 ),
 }}
 />
 </Tab.Navigator>
 <BottomDock />
 </View>
 );
};

const styles = StyleSheet.create({
 container: {
 flex: 1,
 },
 bottomDock: {
 position: 'absolute',
 left: 0,
 right: 0,
 zIndex: 1000,
 },
 failureBannerWrap: {
 flexDirection: 'row',
 alignItems: 'center',
 marginHorizontal: 16,
 marginTop: 8,
 gap: 8,
 },
 failureBanner: {
 flex: 1,
 paddingVertical: 10,
 paddingHorizontal: 14,
 borderRadius: 12,
 borderWidth: 1,
 alignItems: 'center',
 justifyContent: 'center',
 },
 failureBannerText: {
 fontSize: 14,
 fontWeight: '500',
 },
 failureBannerDismiss: {
 paddingVertical: 8,
 paddingHorizontal: 10,
 },
 failureBannerDismissText: {
 fontSize: 13,
 },
 devBadge: {
 position: 'absolute',
 top: 0,
 left: 0,
 right: 0,
 zIndex: 9999,
 backgroundColor: 'rgba(0,0,0,0.75)',
 paddingVertical: 4,
 paddingHorizontal: 8,
 alignItems: 'center',
 },
 devBadgeText: {
 color: '#7fdbff',
 fontSize: 11,
 fontWeight: '600',
 },
});

