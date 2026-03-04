/**
 * Storage Debug Screen
 * Shows local storage breakdown (DocumentDirectory, CacheDirectory, photos/, covers/) and
 * provides a "Clear Cache" button that runs the cache eviction policy.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
  Share,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronBackIcon, TrashIcon, FolderIcon } from '../components/Icons';
import { useTheme } from '../theme/ThemeProvider';
import {
  runStorageAudit,
  formatBytes,
  type StorageAuditResult,
  type FolderStats,
} from '../lib/localStorageAudit';
import { runCacheEviction, type EvictionResult } from '../lib/cacheEviction';
import { exportDebugLogs, getDebugTraceId, setDebugTraceId } from '../utils/logger';
import * as Clipboard from 'expo-clipboard';

interface Props {
  onClose: () => void;
}

function StatRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  const { t } = useTheme();
  const c = t.colors;
  return (
    <View style={styles.statRow}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.statLabel, { color: c.textSecondary }]}>{label}</Text>
        {sub ? <Text style={[styles.statSub, { color: c.textTertiary ?? c.textSecondary }]}>{sub}</Text> : null}
      </View>
      <Text style={[styles.statValue, { color: c.textPrimary }]}>{value}</Text>
    </View>
  );
}

function FolderCard({ folder, title }: { folder: FolderStats; title: string }) {
  const { t } = useTheme();
  const c = t.colors;
  return (
    <View style={[styles.card, { backgroundColor: c.surfacePrimary, borderColor: c.border }]}>
      <Text style={[styles.cardTitle, { color: c.textPrimary }]}>{title}</Text>
      <StatRow
        label="Size"
        value={folder.exists ? formatBytes(folder.totalBytes) : '—'}
      />
      <StatRow
        label="Files"
        value={folder.exists ? String(folder.fileCount) : '—'}
      />
      {folder.fileCount > 0 && (
        <StatRow
          label="Avg file size"
          value={formatBytes(folder.avgBytes)}
        />
      )}
      {!folder.exists && (
        <Text style={[styles.notExists, { color: c.textTertiary ?? c.textSecondary }]}>
          Directory does not exist yet
        </Text>
      )}
    </View>
  );
}

export default function StorageDebugScreen({ onClose }: Props) {
  const { t } = useTheme();
  const c = t.colors;
  const insets = useSafeAreaInsets();

  const [audit, setAudit] = useState<StorageAuditResult | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [evicting, setEvicting] = useState(false);
  const [lastEviction, setLastEviction] = useState<EvictionResult | null>(null);
  const [exportingLogs, setExportingLogs] = useState(false);
  const [debugTraceIdInput, setDebugTraceIdInput] = useState(getDebugTraceId() ?? '');
  const [, setLogFilterVersion] = useState(0);

  const handleExportDebugLogs = useCallback(async () => {
    setExportingLogs(true);
    try {
      const text = exportDebugLogs();
      await Clipboard.setStringAsync(text);
      const result = await Share.share({
        message: text,
        title: 'Debug logs',
      });
      if (result.action === Share.sharedAction) {
        Alert.alert('Exported', 'Last 500 log lines copied and shared.');
      } else {
        Alert.alert('Copied', 'Last 500 log lines copied to clipboard.');
      }
    } catch (e) {
      Alert.alert('Export failed', (e as Error)?.message ?? String(e));
    } finally {
      setExportingLogs(false);
    }
  }, []);

  const runAudit = useCallback(async () => {
    setAuditing(true);
    try {
      const result = await runStorageAudit();
      setAudit(result);
    } catch (e) {
      Alert.alert('Error', `Storage audit failed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setAuditing(false);
    }
  }, []);

  const handleClearCache = useCallback(async () => {
    Alert.alert(
      'Clear Cache',
      'This will:\n\n• Delete cover images older than 30 days\n• Delete all but the 5 most recent scan staging files\n• Clear the Expo temporary file cache\n\nYour library, scans, and book data are not affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear Cache',
          style: 'destructive',
          onPress: async () => {
            setEvicting(true);
            try {
              const result = await runCacheEviction({
                coversMaxAgeDays: 30,
                scanOriginalsKeep: 5,
                clearCacheDir: true,
              });
              setLastEviction(result);
              if (result.errors.length > 0) {
                Alert.alert(
                  'Cache cleared (with warnings)',
                  `Freed ${formatBytes(result.totalBytesFreed)}.\n\nWarnings:\n${result.errors.join('\n')}`
                );
              } else {
                Alert.alert(
                  'Cache cleared',
                  `Freed ${formatBytes(result.totalBytesFreed)} of storage.`
                );
              }
              // Re-audit after eviction to show updated sizes.
              const updated = await runStorageAudit();
              setAudit(updated);
            } catch (e) {
              Alert.alert('Error', `Cache eviction failed: ${(e as Error)?.message ?? String(e)}`);
            } finally {
              setEvicting(false);
            }
          },
        },
      ]
    );
  }, []);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.backgroundPrimary }]}>
      {/* Header: use top inset so back button sits below status bar and is tappable */}
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 44) + 8, borderBottomColor: c.border }]}>
        <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.backButton}>
          <ChevronBackIcon size={24} color={c.textPrimary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: c.textPrimary }]}>Storage Usage</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Debug trace ID: only log lines matching this id (e.g. S-0E49) */}
        <View style={[styles.card, { backgroundColor: c.surfacePrimary, borderColor: c.border }]}>
          <Text style={[styles.cardTitle, { color: c.textPrimary }]}>Log filter: Debug trace ID</Text>
          <Text style={[styles.statLabel, { color: c.textSecondary, marginBottom: 6 }]}>
            Only show logs for one upload/scan. Paste traceId from a log line (e.g. S-0E49).
          </Text>
          <View style={styles.traceIdRow}>
            <TextInput
              style={[styles.traceIdInput, { backgroundColor: c.surfaceSecondary, color: c.textPrimary, borderColor: c.border }]}
              value={debugTraceIdInput}
              onChangeText={setDebugTraceIdInput}
              placeholder="e.g. S-0E49"
              placeholderTextColor={c.textTertiary ?? c.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              onPress={() => {
                const v = debugTraceIdInput.trim();
                setDebugTraceId(v || null);
                setLogFilterVersion((x) => x + 1);
              }}
              style={[styles.traceIdButton, { backgroundColor: c.accentPrimary }]}
            >
              <Text style={[styles.traceIdButtonText, { color: c.primaryText ?? '#fff' }]}>Set</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setDebugTraceId(null);
                setDebugTraceIdInput('');
                setLogFilterVersion((x) => x + 1);
              }}
              style={[styles.traceIdButton, { backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border }]}
            >
              <Text style={[styles.traceIdButtonText, { color: c.textPrimary }]}>Clear</Text>
            </TouchableOpacity>
          </View>
          {getDebugTraceId() != null && (
            <Text style={[styles.statSub, { color: c.textTertiary ?? c.textSecondary, marginTop: 4 }]}>
              Active: {getDebugTraceId()} — only matching logs are printed.
            </Text>
          )}
        </View>

        {/* Measure button */}
        <TouchableOpacity
          onPress={runAudit}
          disabled={auditing}
          style={[styles.primaryButton, { backgroundColor: c.accentPrimary }]}
        >
          {auditing ? (
            <ActivityIndicator color={c.primaryText ?? '#fff'} size="small" />
          ) : (
            <Text style={[styles.primaryButtonText, { color: c.primaryText ?? '#fff' }]}>
              {audit ? 'Re-measure Storage' : 'Measure Storage'}
            </Text>
          )}
        </TouchableOpacity>

        {audit && (
          <>
            {/* Summary card */}
            <View style={[styles.card, { backgroundColor: c.surfacePrimary, borderColor: c.border }]}>
              <Text style={[styles.cardTitle, { color: c.textPrimary }]}>Summary</Text>
              <StatRow
                label="Total (docs + cache)"
                value={formatBytes(audit.totalLocalBytes)}
              />
              <StatRow
                label="Documents directory"
                value={formatBytes(audit.documentDir.totalBytes)}
                sub={`${audit.documentDir.fileCount} files`}
              />
              <StatRow
                label="Cache directory"
                value={formatBytes(audit.cacheDir.totalBytes)}
                sub={`${audit.cacheDir.fileCount} files`}
              />
              <Text style={[styles.timestamp, { color: c.textTertiary ?? c.textSecondary }]}>
                Measured {new Date(audit.computedAt).toLocaleTimeString()}
              </Text>
            </View>

            {/* Per-folder detail */}
            <FolderCard folder={audit.scanStagingSubdir} title="📸 Scan staging (document/scan-staging/)" />
            <FolderCard folder={audit.photosSubdir} title="📷 Legacy photos (doc/photos/)" />
            <FolderCard folder={audit.coversSubdir} title="🖼 Cover cache (covers/)" />
            <FolderCard folder={audit.cacheDir} title="⚡ Expo cache directory" />

            {/* Eviction policy info */}
            <View style={[styles.infoBox, { backgroundColor: c.surfaceSecondary, borderColor: c.border }]}>
              <Text style={[styles.infoTitle, { color: c.textPrimary }]}>Eviction policy</Text>
              <Text style={[styles.infoBody, { color: c.textSecondary }]}>
                • Scan originals: staging files deleted after upload succeeds. Keep last 5 as safety fallback.{'\n'}
                • Cover cache: delete files older than 30 days (always re-downloadable).{'\n'}
                • Expo cache dir: temp manipulator files; always safe to delete.
              </Text>
            </View>

            {/* Clear cache button */}
            <TouchableOpacity
              onPress={handleClearCache}
              disabled={evicting}
              style={[styles.dangerButton, { borderColor: c.danger ?? '#ef4444' }]}
            >
              {evicting ? (
                <ActivityIndicator color={c.danger ?? '#ef4444'} size="small" />
              ) : (
                <>
                  <TrashIcon size={18} color={c.danger ?? '#ef4444'} style={{ marginRight: 8 }} />
                  <Text style={[styles.dangerButtonText, { color: c.danger ?? '#ef4444' }]}>
                    Clear Cache
                  </Text>
                </>
              )}
            </TouchableOpacity>

            {/* Last eviction result */}
            {lastEviction && (
              <View style={[styles.card, { backgroundColor: c.surfacePrimary, borderColor: c.border }]}>
                <Text style={[styles.cardTitle, { color: c.textPrimary }]}>Last eviction result</Text>
                <StatRow label="Total freed" value={formatBytes(lastEviction.totalBytesFreed)} />
                <StatRow
                  label="Cover files deleted"
                  value={`${lastEviction.coversDeleted} (${formatBytes(lastEviction.coversBytesFreed)})`}
                />
                <StatRow
                  label="Scan originals deleted"
                  value={`${lastEviction.photosDeleted} (${formatBytes(lastEviction.photosBytesFreed)})`}
                />
                <StatRow
                  label="Cache dir cleared"
                  value={`${lastEviction.cacheDirCleared ? 'Yes' : 'No'} (${formatBytes(lastEviction.cacheDirBytesFreed)})`}
                />
                {lastEviction.errors.length > 0 && (
                  <Text style={[styles.errorText, { color: c.danger ?? '#ef4444' }]}>
                    Warnings: {lastEviction.errors.join('; ')}
                  </Text>
                )}
              </View>
            )}
          </>
        )}

        {/* Export Debug Logs: last 500 lines from ring buffer (on error / watchdog / manual). */}
        <View style={[styles.card, { backgroundColor: c.surfacePrimary, borderColor: c.border }]}>
          <Text style={[styles.cardTitle, { color: c.textPrimary }]}>Debug logs</Text>
          <Text style={[styles.statLabel, { color: c.textSecondary, marginBottom: 8 }]}>
            Copy and share the last 500 log lines (e.g. to attach to a bug report).
          </Text>
          <TouchableOpacity
            onPress={handleExportDebugLogs}
            disabled={exportingLogs}
            style={[styles.primaryButton, { backgroundColor: c.accentPrimary }]}
          >
            {exportingLogs ? (
              <ActivityIndicator color={c.primaryText ?? '#fff'} size="small" />
            ) : (
              <Text style={[styles.primaryButtonText, { color: c.primaryText ?? '#fff' }]}>
                Export Debug Logs
              </Text>
            )}
          </TouchableOpacity>
        </View>

        {!audit && !auditing && (
          <View style={styles.emptyState}>
            <FolderIcon size={48} color={c.textTertiary ?? c.textSecondary} />
            <Text style={[styles.emptyText, { color: c.textSecondary }]}>
              Tap "Measure Storage" to scan local directories.
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: { width: 36, minHeight: 44, justifyContent: 'center', alignItems: 'flex-start' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  scrollContent: { padding: 16, paddingBottom: 48, gap: 14 },
  primaryButton: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 4,
    elevation: 3,
  },
  primaryButtonText: { fontSize: 16, fontWeight: '700' },
  card: {
    borderRadius: 14,
    padding: 16,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  cardTitle: { fontSize: 15, fontWeight: '700', marginBottom: 4 },
  statRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statLabel: { fontSize: 14 },
  statSub: { fontSize: 12, marginTop: 1 },
  statValue: { fontSize: 14, fontWeight: '600' },
  traceIdRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  traceIdInput: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  traceIdButton: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, justifyContent: 'center' },
  traceIdButtonText: { fontSize: 14, fontWeight: '600' },
  notExists: { fontSize: 13, fontStyle: 'italic', marginTop: 4 },
  timestamp: { fontSize: 12, marginTop: 6, textAlign: 'right' },
  infoBox: {
    borderRadius: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  infoTitle: { fontSize: 14, fontWeight: '700', marginBottom: 6 },
  infoBody: { fontSize: 13, lineHeight: 20 },
  dangerButton: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    borderWidth: 1.5,
  },
  dangerButtonText: { fontSize: 16, fontWeight: '700' },
  errorText: { fontSize: 12, marginTop: 6 },
  emptyState: { alignItems: 'center', paddingTop: 48, gap: 16 },
  emptyText: { fontSize: 15, textAlign: 'center', maxWidth: 260, lineHeight: 22 },
});
