import React from 'react';
import { Modal, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LoginScreen } from '../auth/AuthScreens';
import { useTheme } from '../theme/ThemeProvider';
import { AppHeader } from './AppHeader';

interface LoginModalProps {
  visible: boolean;
  onClose: () => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({ visible, onClose }) => {
  const { t } = useTheme();

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaView style={[styles.container, { backgroundColor: t.colors.bg }]} edges={['left', 'right', 'bottom']}>
        <AppHeader title="Sign In" onBack={onClose} />
        <LoginScreen onAuthSuccess={onClose} />
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

