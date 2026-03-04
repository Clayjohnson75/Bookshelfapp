import React from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';

interface AuthGateModalProps {
  visible: boolean;
  onClose: () => void;
  onSignIn: () => void;
  onCreateAccount: () => void;
}

export const AuthGateModal: React.FC<AuthGateModalProps> = ({
  visible,
  onClose,
  onSignIn,
  onCreateAccount,
}) => {
  const { t } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade">
      <TouchableOpacity
        style={[styles.overlay, { backgroundColor: t.colors.overlay }]}
        activeOpacity={1}
        onPress={onClose}
      >
        <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation()} style={[styles.card, { backgroundColor: t.colors.card }]}>
          <Text style={[styles.title, { color: t.colors.text }]}>Create an account to save your library</Text>
          <Text style={[styles.subtitle, { color: t.colors.textMuted }]}>
            Sign in or create an account to add books to your library and sync across devices.
          </Text>
          <TouchableOpacity style={[styles.primaryButton, { backgroundColor: t.colors.primary }]} onPress={onSignIn}>
            <Text style={[styles.primaryButtonText, { color: t.colors.primaryText }]}>Sign in</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.secondaryButton, { backgroundColor: t.colors.surface2, borderColor: t.colors.border }]} onPress={onCreateAccount}>
            <Text style={[styles.secondaryButtonText, { color: t.colors.text }]}>Create account</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.notNowButton} onPress={onClose}>
            <Text style={[styles.notNowText, { color: t.colors.textMuted }]}>Not now</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 340,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    marginBottom: 20,
    textAlign: 'center',
    lineHeight: 20,
  },
  primaryButton: {
    paddingVertical: 12,
    borderRadius: 10,
    marginBottom: 10,
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  secondaryButton: {
    paddingVertical: 12,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  notNowButton: {
    paddingVertical: 8,
  },
  notNowText: {
    fontSize: 14,
    textAlign: 'center',
  },
});
