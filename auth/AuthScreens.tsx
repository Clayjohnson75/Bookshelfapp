import React, { useState } from 'react';
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
} from 'react-native';
import { useAuth } from './SimpleAuthContext';

interface AuthScreenProps {
  onAuthSuccess: () => void;
}

export const LoginScreen: React.FC<AuthScreenProps> = ({ onAuthSuccess }) => {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(true); // Show by default
  const [showSignUp, setShowSignUp] = useState(false);
  const { signIn, signInWithDemoAccount, loading, demoCredentials } = useAuth();

  const handleLogin = async () => {
    if (!identifier || !password) {
      Alert.alert('Error', 'Please fill in all fields');
      return;
    }

    const success = await signIn(identifier, password);
    if (success) {
      onAuthSuccess();
    }
  };

  const handleDemoLogin = async () => {
    setIdentifier(demoCredentials.username);
    setPassword(demoCredentials.password);
    const success = await signInWithDemoAccount();
    if (success) {
      onAuthSuccess();
    }
  };

  if (showSignUp) {
    return <SignUpScreen onAuthSuccess={onAuthSuccess} onBackToLogin={() => setShowSignUp(false)} />;
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
          <View style={styles.demoContainer}>
            <Text style={styles.demoHeader}>App Review Demo Account</Text>
            <Text style={styles.demoText}>Use the button below or enter these credentials manually:</Text>
            <Text style={styles.demoCredential}>Username: <Text style={styles.demoCode}>{demoCredentials.username}</Text></Text>
            <Text style={styles.demoCredential}>Password: <Text style={styles.demoCode}>{demoCredentials.password}</Text></Text>
            <Text style={styles.demoCredential}>Email: <Text style={styles.demoCode}>{demoCredentials.email}</Text></Text>
            <TouchableOpacity
              style={[styles.button, styles.secondaryButton]}
              onPress={handleDemoLogin}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#007AFF" />
              ) : (
                <Text style={styles.secondaryButtonText}>Sign In Instantly</Text>
              )}
            </TouchableOpacity>
          </View>

          <TextInput
            style={styles.input}
            placeholder="Email or Username"
            value={identifier}
            onChangeText={setIdentifier}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <View style={styles.passwordContainer}>
            <TextInput
              style={[styles.inputField, styles.passwordInput]}
              placeholder="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
            />
            <TouchableOpacity 
              style={styles.eyeButton}
              onPress={() => setShowPassword(!showPassword)}
              activeOpacity={0.7}
            >
              <Text style={styles.eyeButtonPlain}>{showPassword ? 'Show' : 'Hide'}</Text>
            </TouchableOpacity>
          </View>

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
          />

          <View style={styles.passwordContainer}>
            <TextInput
              style={[styles.inputField, styles.passwordInput]}
              placeholder="Password (min 6 characters)"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
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
  demoContainer: {
    marginBottom: 20,
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#f1f5ff',
    borderWidth: 1,
    borderColor: '#c6d8ff',
  },
  demoHeader: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a1a2e',
    marginBottom: 8,
  },
  demoText: {
    fontSize: 14,
    color: '#1a1a2e',
    marginBottom: 8,
  },
  demoCredential: {
    fontSize: 14,
    color: '#1a1a2e',
    marginBottom: 4,
  },
  demoCode: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontWeight: '600',
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
  secondaryButton: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#007AFF',
    marginTop: 12,
  },
  secondaryButtonText: {
    color: '#007AFF',
    fontSize: 16,
    fontWeight: '600',
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
});
