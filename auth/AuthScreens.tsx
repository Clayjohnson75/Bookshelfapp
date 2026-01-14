import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Image,
  Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as LocalAuthentication from 'expo-local-authentication';
import { useAuth } from './SimpleAuthContext';
import * as BiometricAuth from '../services/biometricAuth';

interface AuthScreenProps {
  onAuthSuccess: () => void;
}

export const LoginScreen: React.FC<AuthScreenProps> = ({ onAuthSuccess }) => {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(true); // Show by default
  const [showSignUp, setShowSignUp] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [hasAttemptedBiometric, setHasAttemptedBiometric] = useState(false);
  const { 
    signIn, 
    signInWithDemoAccount, 
    signInWithBiometric,
    resetPassword,
    loading, 
    demoCredentials,
    biometricCapabilities,
    enableBiometric,
    isBiometricEnabled,
  } = useAuth();

  useEffect(() => {
    checkBiometricStatus();
  }, []);

  // Automatically attempt Face ID when biometric is enabled (only once)
  useEffect(() => {
    if (biometricEnabled && biometricCapabilities?.isAvailable && !hasAttemptedBiometric && !loading) {
      // Small delay to ensure screen is fully rendered
      const timer = setTimeout(() => {
        setHasAttemptedBiometric(true);
        attemptAutomaticBiometricLogin();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [biometricEnabled, biometricCapabilities?.isAvailable, hasAttemptedBiometric, loading]);

  const checkBiometricStatus = async () => {
    try {
      const enabled = await isBiometricEnabled();
      setBiometricEnabled(enabled);
    } catch (error) {
      console.error('Error checking biometric status:', error);
    }
  };

  const attemptAutomaticBiometricLogin = async () => {
    try {
      const success = await signInWithBiometric();
      if (success) {
        onAuthSuccess();
      }
      // Silently fail - don't show alert, just show login form
    } catch (error) {
      // Silently fail - don't show alert
      console.log('Automatic biometric login failed, showing login form');
    }
  };

  const handleLogin = async () => {
    const trimmedId = identifier.trim();
    const trimmedPassword = password.trim();

    if (!trimmedId || !trimmedPassword) {
      Alert.alert('Error', 'Please fill in all fields');
      return;
    }

    // Check if demo credentials match (hidden, works in background)
    const matchesDemo =
      trimmedPassword === demoCredentials.password &&
      (trimmedId.toLowerCase() === demoCredentials.username || trimmedId.toLowerCase() === demoCredentials.email.toLowerCase());

    if (matchesDemo) {
      const demoSuccess = await signInWithDemoAccount();
      if (demoSuccess) {
        onAuthSuccess();
      }
      return;
    }

    const success = await signIn(trimmedId, trimmedPassword);
    if (success) {
      // If "Remember Me" is checked and biometric is available, enable it
      if (rememberMe && biometricCapabilities?.isAvailable) {
        try {
          await enableBiometric(trimmedId.includes('@') ? trimmedId : '', trimmedPassword);
          setBiometricEnabled(true);
        } catch (error) {
          console.error('Error enabling biometric:', error);
          // Don't block login if biometric enable fails
        }
      }
      onAuthSuccess();
    }
  };

  // Removed handleBiometricLogin - Face ID now works automatically

  const handleForgotPassword = async () => {
    const email = resetEmail.trim();
    
    if (!email) {
      Alert.alert('Error', 'Please enter your email address');
      return;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      Alert.alert('Error', 'Please enter a valid email address');
      return;
    }

    setResetLoading(true);
    try {
      const success = await resetPassword(email);
      if (success) {
        setShowForgotPassword(false);
        setResetEmail('');
      }
    } catch (error) {
      console.error('Password reset error:', error);
    } finally {
      setResetLoading(false);
    }
  };

  if (showSignUp) {
    return <SignUpScreen onAuthSuccess={onAuthSuccess} onBackToLogin={() => setShowSignUp(false)} />;
  }

  if (showForgotPassword) {
    return (
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.scrollContainer}>
          <View style={styles.header}>
            <Image source={require('../assets/logo/logo.png')} style={styles.logo} resizeMode="contain" />
            <Text style={styles.title}>Reset Password</Text>
            <Text style={styles.subtitle}>Enter your email to receive a reset link</Text>
          </View>

          <View style={styles.form}>
            <TextInput
              style={styles.input}
              placeholder="Email"
              value={resetEmail}
              onChangeText={setResetEmail}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="emailAddress"
              autoComplete="email"
              keyboardType="email-address"
              editable={!resetLoading}
            />

            <TouchableOpacity
              style={[styles.button, styles.primaryButton]}
              onPress={handleForgotPassword}
              disabled={resetLoading}
            >
              {resetLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Send Reset Link</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.linkButton}
              onPress={() => {
                setShowForgotPassword(false);
                setResetEmail('');
              }}
            >
              <Text style={styles.linkText}>Back to Sign In</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.scrollContainer}>
        <View style={styles.header}>
          <Image source={require('../assets/logo/logo.png')} style={styles.logo} resizeMode="contain" />
          <Text style={styles.title}>Bookshelf Scanner</Text>
          <Text style={styles.subtitle}>Sign in to access your library</Text>
        </View>

        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder="Email or Username"
            value={identifier}
            onChangeText={setIdentifier}
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="username"
            autoComplete="username"
            keyboardType="email-address"
          />

          <View style={styles.passwordContainer}>
            <TextInput
              style={[styles.inputField, styles.passwordInput]}
              placeholder="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              textContentType="password"
              autoComplete="password"
            />
            <TouchableOpacity 
              style={styles.eyeButton}
              onPress={() => setShowPassword(!showPassword)}
              activeOpacity={0.7}
            >
              <Text style={styles.eyeButtonPlain}>{showPassword ? 'Show' : 'Hide'}</Text>
            </TouchableOpacity>
          </View>

          {/* Remember Me Toggle */}
          {biometricCapabilities?.isAvailable && (
            <View style={styles.rememberMeContainer}>
              <Switch
                value={rememberMe}
                onValueChange={setRememberMe}
                trackColor={{ false: '#767577', true: '#0056CC' }}
                thumbColor={rememberMe ? '#fff' : '#f4f3f4'}
              />
              <Text style={styles.rememberMeText}>
                Remember me & enable {BiometricAuth.getBiometricTypeName(biometricCapabilities)}
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={[styles.button, styles.primaryButton]}
            onPress={handleLogin}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Sign In</Text>
            )}
          </TouchableOpacity>

          {/* Face ID now works automatically - no button needed */}

          <TouchableOpacity
            style={styles.linkButton}
            onPress={() => setShowForgotPassword(true)}
          >
            <Text style={styles.linkText}>Forgot Password?</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.linkButton}
            onPress={() => setShowSignUp(true)}
          >
            <Text style={styles.linkText}>Don't have an account? Sign up</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

interface SignUpScreenProps extends AuthScreenProps {
  onBackToLogin: () => void;
}

export const SignUpScreen: React.FC<SignUpScreenProps> = ({ onAuthSuccess, onBackToLogin }) => {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(true); // Show by default
  const [showConfirmPassword, setShowConfirmPassword] = useState(true); // Show by default
  const { signUp, loading } = useAuth();

  const handleSignUp = async () => {
    if (!email || !password || !username || !displayName) {
      Alert.alert('Error', 'Please fill in all fields');
      return;
    }

    if (password !== confirmPassword) {
      Alert.alert('Error', 'Passwords do not match');
      return;
    }

    if (password.length < 6) {
      Alert.alert('Error', 'Password must be at least 6 characters');
      return;
    }

    if (username.length < 3 || username.length > 20) {
      Alert.alert('Error', 'Username must be between 3 and 20 characters');
      return;
    }

    const success = await signUp(email, password, username, displayName);
    if (success) {
      onAuthSuccess();
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.scrollContainer}>
        <View style={styles.header}>
          <Image source={require('../assets/logo/logo.png')} style={styles.logo} resizeMode="contain" />
          <Text style={styles.title}>Bookshelf Scanner</Text>
          <Text style={styles.subtitle}>Create your account</Text>
        </View>

        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder="Full Name"
            value={displayName}
            onChangeText={setDisplayName}
            autoCapitalize="words"
            autoCorrect={false}
            keyboardType="default"
          />

          <TextInput
            style={styles.input}
            placeholder="Username (required, 3-20 chars)"
            value={username}
            onChangeText={(text) => setUsername(text.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={20}
            required
          />

          <TextInput
            style={styles.input}
            placeholder="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="emailAddress"
            autoComplete="email"
          />

          <View style={styles.passwordContainer}>
            <TextInput
              style={[styles.inputField, styles.passwordInput]}
              placeholder="Password (min 6 characters)"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              textContentType="newPassword"
              autoComplete="password-new"
              passwordRules="minlength: 6;"
            />
            <TouchableOpacity 
              style={styles.eyeButton}
              onPress={() => setShowPassword(!showPassword)}
              activeOpacity={0.7}
            >
              <Text style={styles.eyeButtonPlain}>{showPassword ? 'Show' : 'Hide'}</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.passwordContainer}>
            <TextInput
              style={[styles.inputField, styles.passwordInput]}
              placeholder="Confirm Password"
              textContentType="none"
              autoComplete="off"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry={!showConfirmPassword}
              autoCapitalize="none"
            />
            <TouchableOpacity 
              style={styles.eyeButton}
              onPress={() => setShowConfirmPassword(!showConfirmPassword)}
              activeOpacity={0.7}
            >
              <Text style={styles.eyeButtonPlain}>{showConfirmPassword ? 'Show' : 'Hide'}</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.button, styles.primaryButton]}
            onPress={handleSignUp}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Sign Up</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.linkButton}
            onPress={onBackToLogin}
          >
            <Text style={styles.linkText}>Already have an account? Sign in</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  scrollContainer: {
    flexGrow: 1,
    justifyContent: 'flex-start',
    padding: 20,
    paddingTop: 40,
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
    backgroundColor: 'transparent',
    paddingTop: 10,
    paddingBottom: 10,
    borderRadius: 0,
  },
  logo: {
    width: 240,
    height: 240,
    marginBottom: 12,
    backgroundColor: 'transparent',
  },
  title: {
    fontSize: 32,
    fontWeight: '800',
    color: '#1a1a2e',
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  subtitle: {
    fontSize: 16,
    color: '#1a1a2e',
    fontWeight: '500',
  },
  form: {
    width: '100%',
  },
  input: {
    backgroundColor: '#fff',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderRadius: 12,
    marginBottom: 15,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  // Input field used inside passwordContainer, matches .input dimensions
  inputField: {
    flex: 1,
    backgroundColor: '#fff',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderRadius: 12,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 15,
    position: 'relative',
    borderRadius: 12,
  },
  passwordInput: {
    paddingRight: 70, // Leave space for the eye button
  },
  eyeButton: {
    position: 'absolute',
    right: 10,
    padding: 10,
    zIndex: 1,
  },
  eyeButtonPlain: {
    fontSize: 13,
    color: '#007AFF',
    fontWeight: '600',
  },
  button: {
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 15,
  },
  primaryButton: {
    backgroundColor: '#007AFF',
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  linkButton: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  linkText: {
    color: '#007AFF',
    fontSize: 16,
  },
  rememberMeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    marginTop: 8,
  },
  rememberMeText: {
    marginLeft: 10,
    fontSize: 14,
    color: '#333',
  },
  biometricButton: {
    backgroundColor: '#4A90E2',
    marginTop: 12,
  },
});

export const PasswordResetScreen: React.FC<AuthScreenProps & { accessToken: string }> = ({ onAuthSuccess, accessToken }) => {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const { updatePassword } = useAuth();

  const handleResetPassword = async () => {
    if (!newPassword || !confirmPassword) {
      Alert.alert('Error', 'Please fill in all fields');
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert('Error', 'Passwords do not match');
      return;
    }
    if (newPassword.length < 6) {
      Alert.alert('Error', 'Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    try {
      const success = await updatePassword(accessToken, newPassword);
      if (success) {
        onAuthSuccess(); // Go to main app after successful reset
      }
    } catch (error) {
      console.error('Password reset error:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.scrollContainer}>
        <View style={styles.header}>
          <Image source={require('../assets/logo/logo.png')} style={styles.logo} resizeMode="contain" />
          <Text style={styles.title}>Set New Password</Text>
          <Text style={styles.subtitle}>Enter your new password below</Text>
        </View>

        <View style={styles.form}>
          <View style={styles.passwordContainer}>
            <TextInput
              style={[styles.inputField, styles.passwordInput]}
              placeholder="New Password (min 6 characters)"
              value={newPassword}
              onChangeText={setNewPassword}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              textContentType="newPassword"
              autoComplete="new-password"
              passwordRules="minlength: 6;"
            />
            <TouchableOpacity 
              style={styles.eyeButton}
              onPress={() => setShowPassword(!showPassword)}
              activeOpacity={0.7}
            >
              <Text style={styles.eyeButtonPlain}>{showPassword ? 'Hide' : 'Show'}</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.passwordContainer}>
            <TextInput
              style={[styles.inputField, styles.passwordInput]}
              placeholder="Confirm New Password"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry={!showConfirmPassword}
              autoCapitalize="none"
              textContentType="none"
              autoComplete="off"
            />
            <TouchableOpacity 
              style={styles.eyeButton}
              onPress={() => setShowConfirmPassword(!showConfirmPassword)}
              activeOpacity={0.7}
            >
              <Text style={styles.eyeButtonPlain}>{showConfirmPassword ? 'Hide' : 'Show'}</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.button, styles.primaryButton]}
            onPress={handleResetPassword}
            disabled={loading || !newPassword.trim() || !confirmPassword.trim()}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Reset Password</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};
