import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiRequest, getAppConfig, type Product, type SellerStatus } from '../src/lib/api';
import { getSupabaseClient } from '../src/lib/supabase';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, '') ?? '';
const CATEGORIES = ['All', 'Home', 'Accessories', 'Art', 'Clothing', 'Other'];
const CATEGORY_ART: Record<string, { emoji: string; color: string }> = {
  Home: { emoji: '🪴', color: '#E9DED2' },
  Accessories: { emoji: '👜', color: '#DDE5D9' },
  Art: { emoji: '🎨', color: '#E9E3CB' },
  Clothing: { emoji: '🧣', color: '#E2DCE9' },
  Other: { emoji: '✨', color: '#E7E4DA' },
};
const COUNTRIES = [
  ['IE', 'Ireland'],
  ['NL', 'Netherlands'],
  ['BE', 'Belgium'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['ES', 'Spain'],
  ['IT', 'Italy'],
  ['PT', 'Portugal'],
  ['AT', 'Austria'],
] as const;

type Cart = Record<string, number>;
type AuthMode = 'login' | 'signup';

function formatPrice(amount: number) {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(amount);
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  maxLength,
  secureTextEntry = false,
  keyboardType = 'default',
  autoCapitalize = 'sentences',
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  maxLength?: number;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address' | 'decimal-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#96988F"
        maxLength={maxLength}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={secureTextEntry ? 'none' : autoCapitalize}
        autoCorrect={false}
      />
    </View>
  );
}

export default function MarketplaceScreen() {
  const insets = useSafeAreaInsets();
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Cart>(() => {
    try {
      const saved = localStorage.getItem('buba-mobile-cart');
      const parsed: unknown = saved ? JSON.parse(saved) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, number] =>
          Number.isInteger(entry[1]) && Number(entry[1]) > 0,
        ),
      );
    } catch (cause) {
      console.error('Unable to restore the saved Buba bag.', cause);
      return {};
    }
  });
  const [activeCategory, setActiveCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [authVisible, setAuthVisible] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [accountVisible, setAccountVisible] = useState(false);
  const [bagVisible, setBagVisible] = useState(false);
  const [sellerVisible, setSellerVisible] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [sellerBusy, setSellerBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [sellerError, setSellerError] = useState('');
  const [sellerStatus, setSellerStatus] = useState<SellerStatus | null>(null);
  const [sellerCountry, setSellerCountry] = useState('IE');
  const [listingName, setListingName] = useState('');
  const [listingPrice, setListingPrice] = useState('');
  const [listingCategory, setListingCategory] = useState('Home');
  const [listingBusy, setListingBusy] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [country, setCountry] = useState('IE');

  const loadProducts = useCallback(async (baseUrl: string, token?: string) => {
    const result = await apiRequest<{ products: Product[] }>(baseUrl, '/api/products', {}, token);
    setProducts(result.products);
    setCart(previous => {
      const available = new Map(result.products.map(product => [product.id, product]));
      const next: Cart = {};
      const sellerIds = new Set<string>();
      Object.entries(previous).forEach(([id, quantity]) => {
        const product = available.get(id);
        if (!product || !Number.isInteger(quantity) || quantity < 1) return;
        sellerIds.add(product.sellerId);
        if (sellerIds.size === 1) next[id] = Math.min(quantity, 20);
      });
      return next;
    });
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('buba-mobile-cart', JSON.stringify(cart));
    } catch (cause) {
      console.error('Unable to save the Buba bag.', cause);
    }
  }, [cart]);

  useEffect(() => {
    let alive = true;
    let authSubscription: { unsubscribe: () => void } | undefined;
    let linkSubscription: { remove: () => void } | undefined;
    async function initialize() {
      if (!API_BASE_URL) {
        setError('Set EXPO_PUBLIC_API_URL in mobile/.env to your Buba server address.');
        setLoading(false);
        return;
      }
      try {
        const appConfig = await getAppConfig(API_BASE_URL);
        const client = getSupabaseClient(appConfig);
        const { data, error: sessionError } = await client.auth.getSession();
        if (sessionError) throw sessionError;
        if (!alive) return;
        setSupabase(client);
        setSession(data.session);
        authSubscription = client.auth.onAuthStateChange((_event, nextSession) => {
          if (!alive) return;
          setSession(nextSession);
          if (_event === 'PASSWORD_RECOVERY') {
            setAuthMode('login');
            setRecoveryMode(true);
            setAuthError('');
            setAuthVisible(true);
          }
        }).data.subscription;
        const processedUrls = new Set<string>();
        const handleAuthUrl = async (url: string) => {
          if (!url.includes('/auth/callback') || processedUrls.has(url)) return;
          processedUrls.add(url);
          try {
            const code = new URL(url).searchParams.get('code');
            if (!code) throw new Error('The sign-in link is invalid or has expired.');
            const { error: exchangeError } = await client.auth.exchangeCodeForSession(code);
            if (exchangeError) throw exchangeError;
          } catch (cause) {
            if (!alive) return;
            setAuthMode('login');
            setAuthError(cause instanceof Error ? cause.message : 'Unable to verify this email link.');
            setAuthVisible(true);
          }
        };
        linkSubscription = Linking.addEventListener('url', ({ url }) => {
          void handleAuthUrl(url);
        });
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl) await handleAuthUrl(initialUrl);
        await loadProducts(API_BASE_URL, data.session?.access_token);
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : 'Unable to start Buba.');
      } finally {
        if (alive) setLoading(false);
      }
    }
    void initialize();
    return () => {
      alive = false;
      authSubscription?.unsubscribe();
      linkSubscription?.remove();
    };
  }, [loadProducts]);

  const visibleProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return products.filter(product =>
      (activeCategory === 'All' || product.category === activeCategory) &&
      `${product.name} ${product.category} ${product.seller}`.toLowerCase().includes(query),
    );
  }, [products, activeCategory, search]);

  const cartProducts = useMemo(
    () => products.filter(product => (cart[product.id] ?? 0) > 0),
    [products, cart],
  );
  const itemCount = Object.values(cart).reduce((total, quantity) => total + quantity, 0);
  const subtotal = cartProducts.reduce((total, product) => total + product.price * cart[product.id], 0);

  const refreshProducts = useCallback(async () => {
    if (!API_BASE_URL) return;
    setRefreshing(true);
    setError('');
    try {
      await loadProducts(API_BASE_URL, session?.access_token);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to refresh products.');
    } finally {
      setRefreshing(false);
    }
  }, [loadProducts, session?.access_token]);

  function addToCart(product: Product) {
    const sellerConflict = cartProducts.some(item => item.sellerId !== product.sellerId);
    if (sellerConflict) {
      Alert.alert(
        'One seller at a time',
        'Checkout is limited to one seller. Remove the other seller’s items from your bag first.',
      );
      return;
    }
    if ((cart[product.id] ?? 0) >= 20) {
      Alert.alert('Quantity limit', 'You can add up to 20 of each item.');
      return;
    }
    setCart(previous => ({ ...previous, [product.id]: (previous[product.id] ?? 0) + 1 }));
  }

  function changeQuantity(productId: string, change: number) {
    setCart(previous => {
      const quantity = (previous[productId] ?? 0) + change;
      if (quantity <= 0) {
        const next = { ...previous };
        delete next[productId];
        return next;
      }
      if (quantity > 20) return previous;
      return { ...previous, [productId]: quantity };
    });
  }

  function openAuth(mode: AuthMode = 'login') {
    setAuthMode(mode);
    setRecoveryMode(false);
    setAuthError('');
    setAuthVisible(true);
  }

  async function submitAuth() {
    if (!supabase) {
      setAuthError('Authentication is not configured. Check your Buba server settings.');
      return;
    }
    setAuthBusy(true);
    setAuthError('');
    try {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        throw new Error('Enter a valid email address.');
      }
      if (password.length < 8) {
        throw new Error('Your password must be at least 8 characters long.');
      }
      if (authMode === 'login') {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (signInError) throw signInError;
        setAuthVisible(false);
        return;
      }
      const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
      if (!firstName.trim() || !lastName.trim() || !address.trim() || !city.trim() || !postalCode.trim()) {
        throw new Error('Complete your name and delivery address to create an account.');
      }
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            full_name: fullName,
            delivery_address: address.trim(),
            city: city.trim(),
            postal_code: postalCode.trim(),
            country,
          },
          emailRedirectTo: Linking.createURL('auth/callback'),
        },
      });
      if (signUpError) throw signUpError;
      setAuthVisible(false);
      if (!data.session) {
        Alert.alert('Check your email', 'Supabase sent a verification link to finish creating your account.');
      }
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : 'Unable to complete sign in.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function openBag() {
    if (!session?.user.email_confirmed_at) {
      if (itemCount === 0) {
        setBagVisible(true);
        return;
      }
      openAuth();
      Alert.alert(
        'Sign in to checkout',
        session ? 'Verify your email before checking out.' : 'Sign in and verify your email to continue.',
      );
      return;
    }
    setBagVisible(true);
  }

  async function startCheckout() {
    if (!API_BASE_URL || !session?.access_token || !session.user.email_confirmed_at) {
      setBagVisible(false);
      openAuth();
      return;
    }
    try {
      const checkout = await apiRequest<{ url: string; sessionId?: string }>(
        API_BASE_URL,
        '/api/checkout-session',
        {
          method: 'POST',
          body: JSON.stringify({
            paymentMethod: 'card',
            items: cartProducts.map(product => ({ id: product.id, quantity: cart[product.id] })),
          }),
        },
        session.access_token,
      );
      setBagVisible(false);
      await WebBrowser.openBrowserAsync(checkout.url);
      if (checkout.sessionId) {
        const result = await apiRequest<{ status: string; amount: number }>(
          API_BASE_URL,
          `/api/checkout-status?session_id=${encodeURIComponent(checkout.sessionId)}`,
          {},
          session.access_token,
        );
        if (result.status === 'paid') {
          setCart({});
          Alert.alert(
            'Payment confirmed',
            `Stripe confirmed your payment of ${formatPrice(result.amount)}.`,
          );
        } else {
          Alert.alert('Payment processing', 'Stripe has not confirmed payment yet. Your bag is unchanged.');
        }
      }
    } catch (cause) {
      Alert.alert('Checkout unavailable', cause instanceof Error ? cause.message : 'Unable to start checkout.');
    }
  }

  async function openSeller() {
    if (!session?.user.email_confirmed_at) {
      openAuth();
      Alert.alert('Sign in to sell', 'Sign in and verify your email before opening a shop.');
      return;
    }
    setSellerError('');
    setSellerVisible(true);
    setSellerBusy(true);
    try {
      const status = await apiRequest<SellerStatus>(
        API_BASE_URL,
        '/api/connect/status',
        {},
        session.access_token,
      );
      setSellerStatus(status);
      if (status.country) setSellerCountry(status.country);
    } catch (cause) {
      setSellerError(cause instanceof Error ? cause.message : 'Unable to load seller account.');
    } finally {
      setSellerBusy(false);
    }
  }

  async function connectSeller() {
    if (!session?.access_token) return;
    setSellerBusy(true);
    setSellerError('');
    try {
      const result = await apiRequest<{ connected?: boolean; url?: string }>(
        API_BASE_URL,
        '/api/connect/onboarding',
        { method: 'POST', body: JSON.stringify({ country: sellerCountry }) },
        session.access_token,
      );
      if (result.url) await WebBrowser.openBrowserAsync(result.url);
      const status = await apiRequest<SellerStatus>(
        API_BASE_URL,
        '/api/connect/status',
        {},
        session.access_token,
      );
      setSellerStatus(status);
    } catch (cause) {
      setSellerError(cause instanceof Error ? cause.message : 'Unable to connect seller payouts.');
    } finally {
      setSellerBusy(false);
    }
  }

  async function publishProduct() {
    if (!session?.access_token) return;
    const price = Number(listingPrice);
    if (!listingName.trim() || !Number.isFinite(price) || price <= 0) {
      setSellerError('Enter a product name and a valid price.');
      return;
    }
    setListingBusy(true);
    setSellerError('');
    try {
      await apiRequest<Product>(
        API_BASE_URL,
        '/api/products',
        {
          method: 'POST',
          body: JSON.stringify({ name: listingName.trim(), category: listingCategory, price }),
        },
        session.access_token,
      );
      setListingName('');
      setListingPrice('');
      await loadProducts(API_BASE_URL, session.access_token);
      Alert.alert('Product listed', 'Your product is now available in the Buba marketplace.');
    } catch (cause) {
      setSellerError(cause instanceof Error ? cause.message : 'Unable to publish your product.');
    } finally {
      setListingBusy(false);
    }
  }

  async function signOut() {
    if (!supabase) return;
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      Alert.alert('Unable to sign out', signOutError.message);
      return;
    }
    setAccountVisible(false);
    setSellerStatus(null);
  }

  async function requestPasswordReset() {
    if (!supabase) {
      setAuthError('Authentication is not configured. Check your Buba server settings.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setAuthError('Enter your email address first.');
      return;
    }
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: Linking.createURL('auth/callback'),
      });
      if (resetError) throw resetError;
      setAuthVisible(false);
      Alert.alert('Check your email', 'If that address has an account, Supabase will send a secure password reset link.');
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : 'Unable to send a password reset email.');
    }
  }

  async function updatePassword() {
    if (!supabase) return;
    setAuthError('');
    if (newPassword.length < 8) {
      setAuthError('Your password must be at least 8 characters long.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setAuthError('Your passwords do not match.');
      return;
    }
    setAuthBusy(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) throw updateError;
      setRecoveryMode(false);
      setAuthVisible(false);
      setNewPassword('');
      setConfirmNewPassword('');
      Alert.alert('Password updated', 'Your Buba password has been changed.');
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : 'Unable to update your password.');
    } finally {
      setAuthBusy(false);
    }
  }

  function renderProduct({ item }: { item: Product }) {
    const art = CATEGORY_ART[item.category] ?? CATEGORY_ART.Other;
    return (
      <View style={styles.productCard}>
        <View style={[styles.productArt, { backgroundColor: art.color }]}>
          <Text style={styles.productEmoji}>{art.emoji}</Text>
          <Text style={styles.productTag}>{item.category}</Text>
          <Pressable
            accessibilityLabel={`Add ${item.name} to bag`}
            accessibilityRole="button"
            onPress={() => addToCart(item)}
            style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
          >
            <Text style={styles.addButtonText}>+</Text>
          </Pressable>
        </View>
        <Text numberOfLines={2} style={styles.productName}>{item.name}</Text>
        <View style={styles.productBottom}>
          <Text numberOfLines={1} style={styles.productSeller}>{item.seller}</Text>
          <Text style={styles.productPrice}>{formatPrice(item.price)}</Text>
        </View>
      </View>
    );
  }

  const accountLabel = session?.user.user_metadata?.full_name || session?.user.email?.split('@')[0] || 'Account';

  if (loading) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator size="large" color="#315C43" />
        <Text style={styles.loadingText}>Opening Buba...</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <FlatList
        data={visibleProducts}
        keyExtractor={item => item.id}
        renderItem={renderProduct}
        numColumns={2}
        columnWrapperStyle={styles.productRow}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}
        refreshing={refreshing}
        onRefresh={refreshProducts}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <>
            <View style={styles.topBar}>
              <View>
                <Text style={styles.wordmark}>buba.</Text>
                <Text style={styles.tagline}>GOOD FINDS, GOOD PEOPLE</Text>
              </View>
              <View style={styles.topActions}>
                <Pressable style={styles.accountButton} onPress={() => setAccountVisible(true)}>
                  <Text numberOfLines={1} style={styles.accountButtonText}>
                    {session ? accountLabel : 'Log in'}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityLabel={`Open bag, ${itemCount} items`}
                  accessibilityRole="button"
                  style={styles.bagButton}
                  onPress={() => void openBag()}
                >
                  <Text style={styles.bagButtonText}>Bag</Text>
                  <Text style={styles.bagCount}>{itemCount}</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.hero}>
              <View style={styles.heroDecoration} />
              <Text style={styles.heroEyebrow}>THOUGHTFULLY FOUND, READY FOR YOU</Text>
              <Text style={styles.heroTitle}>Good things,{'\n'}found here.</Text>
              <Text style={styles.heroBody}>
                Lovely finds from independent makers, with a little more meaning.
              </Text>
              <Pressable style={styles.heroButton} onPress={() => setSearch('')}>
                <Text style={styles.heroButtonText}>Explore the collection  →</Text>
              </Pressable>
            </View>

            <View style={styles.sectionHeading}>
              <View>
                <Text style={styles.sectionTitle}>A few good finds</Text>
                <Text style={styles.sectionSubtitle}>Little treasures from sellers worth knowing.</Text>
              </View>
              <Pressable onPress={() => void openSeller()} style={styles.sellLink}>
                <Text style={styles.sellLinkText}>Sell with us  ↗</Text>
              </Pressable>
            </View>

            <TextInput
              accessibilityLabel="Search products"
              value={search}
              onChangeText={setSearch}
              placeholder="Search the collection"
              placeholderTextColor="#96988F"
              style={styles.searchInput}
              returnKeyType="search"
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.categoryList}
            >
              {CATEGORIES.map(category => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: activeCategory === category }}
                  key={category}
                  onPress={() => setActiveCategory(category)}
                  style={[styles.categoryChip, activeCategory === category && styles.categoryChipActive]}
                >
                  <Text style={[styles.categoryText, activeCategory === category && styles.categoryTextActive]}>
                    {category}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            {!!error && <Text accessibilityRole="alert" style={styles.errorBanner}>{error}</Text>}
          </>
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyEmoji}>{error ? '🌱' : '🧺'}</Text>
            <Text style={styles.emptyTitle}>{error ? 'A little setup is needed' : 'No finds just yet'}</Text>
            <Text style={styles.emptyCopy}>
              {error ? 'Check the server settings, then pull down to try again.' : 'Try another search, or check back soon.'}
            </Text>
          </View>
        }
        ListFooterComponent={
          <View style={styles.communityCard}>
            <Text style={styles.communityEmoji}>🪴</Text>
            <Text style={styles.communityEyebrow}>MADE FOR SMALL SELLERS</Text>
            <Text style={styles.communityTitle}>Your good thing could be someone’s new favorite.</Text>
            <Pressable style={styles.communityButton} onPress={() => void openSeller()}>
              <Text style={styles.communityButtonText}>Open your shop  →</Text>
            </Pressable>
          </View>
        }
      />

      <Modal
        animationType="slide"
        onRequestClose={() => setBagVisible(false)}
        transparent
        visible={bagVisible}
      >
        <View style={styles.modalShade}>
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom + 18, 28) }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeading}>
              <View>
                <Text style={styles.sheetTitle}>Your bag</Text>
                <Text style={styles.sheetSubtitle}>{itemCount} {itemCount === 1 ? 'good find' : 'good finds'}</Text>
              </View>
              <Pressable accessibilityLabel="Close bag" onPress={() => setBagVisible(false)} style={styles.closeButton}>
                <Text style={styles.closeText}>×</Text>
              </Pressable>
            </View>
            <ScrollView style={styles.sheetItems}>
              {cartProducts.length === 0 ? (
                <View style={styles.emptyBag}>
                  <Text style={styles.emptyEmoji}>🧺</Text>
                  <Text style={styles.emptyTitle}>Your bag is waiting for a good find.</Text>
                  <Pressable style={styles.textButton} onPress={() => setBagVisible(false)}>
                    <Text style={styles.textButtonLabel}>Keep browsing</Text>
                  </Pressable>
                </View>
              ) : cartProducts.map(product => {
                const art = CATEGORY_ART[product.category] ?? CATEGORY_ART.Other;
                const quantity = cart[product.id];
                return (
                  <View key={product.id} style={styles.cartRow}>
                    <View style={[styles.cartArt, { backgroundColor: art.color }]}>
                      <Text style={styles.cartEmoji}>{art.emoji}</Text>
                    </View>
                    <View style={styles.cartDetails}>
                      <Text numberOfLines={2} style={styles.cartName}>{product.name}</Text>
                      <Text style={styles.cartPrice}>{formatPrice(product.price)}</Text>
                      <View style={styles.quantityControl}>
                        <Pressable accessibilityLabel={`Remove one ${product.name}`} onPress={() => changeQuantity(product.id, -1)} style={styles.quantityButton}>
                          <Text style={styles.quantityButtonText}>−</Text>
                        </Pressable>
                        <Text style={styles.quantityText}>{quantity}</Text>
                        <Pressable accessibilityLabel={`Add one ${product.name}`} disabled={quantity >= 20} onPress={() => changeQuantity(product.id, 1)} style={[styles.quantityButton, quantity >= 20 && styles.disabledButton]}>
                          <Text style={styles.quantityButtonText}>+</Text>
                        </Pressable>
                      </View>
                    </View>
                    <Text style={styles.cartLineTotal}>{formatPrice(product.price * quantity)}</Text>
                  </View>
                );
              })}
            </ScrollView>
            <View style={styles.cartFooter}>
              <View style={styles.subtotalRow}>
                <Text style={styles.subtotalLabel}>Subtotal</Text>
                <Text style={styles.subtotalValue}>{formatPrice(subtotal)}</Text>
              </View>
              <Pressable
                disabled={itemCount === 0}
                onPress={() => void startCheckout()}
                style={[styles.primaryButton, itemCount === 0 && styles.disabledPrimary]}
              >
                <Text style={styles.primaryButtonText}>Continue to secure checkout</Text>
              </Pressable>
              <Text style={styles.cartNote}>Shipping is arranged with the seller.</Text>
            </View>
          </View>
        </View>
      </Modal>

      <Modal animationType="slide" onRequestClose={() => setAuthVisible(false)} visible={authVisible}>
        <KeyboardAvoidingView style={[styles.authScreen, { paddingTop: insets.top + 12 }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.authHeader}>
            <Text style={styles.wordmark}>buba.</Text>
            <Pressable accessibilityLabel="Close sign in" onPress={() => setAuthVisible(false)} style={styles.closeButton}>
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.authContent}>
            <Text style={styles.authEyebrow}>{recoveryMode ? 'ACCOUNT SECURITY' : authMode === 'signup' ? 'A GOOD PLACE TO BEGIN' : 'WELCOME BACK'}</Text>
            <Text style={styles.authTitle}>{recoveryMode ? 'Choose a new password.' : authMode === 'signup' ? 'Join the good finds.' : 'Good to see you.'}</Text>
            <Text style={styles.authIntro}>
              {recoveryMode ? 'Set a new password for your Buba account.' : authMode === 'signup' ? 'Create an account to keep your good finds together.' : 'Log in to your Buba account.'}
            </Text>
            {!recoveryMode && authMode === 'signup' && (
              <>
                <View style={styles.formRow}>
                  <View style={styles.formHalf}><Field label="First name" value={firstName} onChangeText={setFirstName} placeholder="First name" maxLength={50} autoCapitalize="words" /></View>
                  <View style={styles.formHalf}><Field label="Last name" value={lastName} onChangeText={setLastName} placeholder="Last name" maxLength={50} autoCapitalize="words" /></View>
                </View>
                <Field label="Delivery address" value={address} onChangeText={setAddress} placeholder="Street and number" maxLength={160} />
                <View style={styles.formRow}>
                  <View style={styles.formHalf}><Field label="Town / city" value={city} onChangeText={setCity} placeholder="Town or city" maxLength={80} autoCapitalize="words" /></View>
                  <View style={styles.formHalf}><Field label="Postcode" value={postalCode} onChangeText={setPostalCode} placeholder="Postcode" maxLength={20} autoCapitalize="words" /></View>
                </View>
                <Text style={styles.fieldLabel}>Country</Text>
                <View style={styles.countryList}>
                  {COUNTRIES.map(([code, name]) => (
                    <Pressable key={code} onPress={() => setCountry(code)} style={[styles.countryChip, country === code && styles.countryChipActive]}>
                      <Text style={[styles.countryText, country === code && styles.countryTextActive]}>{name}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}
            {!recoveryMode && (
              <>
                <Field label="Email address" value={email} onChangeText={setEmail} placeholder="you@example.com" maxLength={254} keyboardType="email-address" autoCapitalize="none" />
                <Field label="Password" value={password} onChangeText={setPassword} placeholder="At least 8 characters" secureTextEntry />
              </>
            )}
            {recoveryMode && (
              <>
                <Field label="New password" value={newPassword} onChangeText={setNewPassword} placeholder="At least 8 characters" secureTextEntry />
                <Field label="Re-enter new password" value={confirmNewPassword} onChangeText={setConfirmNewPassword} placeholder="Re-enter your password" secureTextEntry />
              </>
            )}
            {!!authError && <Text accessibilityRole="alert" style={styles.inlineError}>{authError}</Text>}
            <Pressable disabled={authBusy} onPress={() => void (recoveryMode ? updatePassword() : submitAuth())} style={[styles.primaryButton, authBusy && styles.disabledPrimary]}>
              {authBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>{recoveryMode ? 'Update password' : authMode === 'signup' ? 'Create account' : 'Log in'}</Text>}
            </Pressable>
            {!recoveryMode && authMode === 'login' && (
              <Pressable onPress={() => void requestPasswordReset()} style={styles.textButton}>
                <Text style={styles.textButtonLabel}>Forgot password?</Text>
              </Pressable>
            )}
            {!recoveryMode && (
              <>
                <Pressable onPress={() => { setAuthMode(authMode === 'login' ? 'signup' : 'login'); setAuthError(''); }} style={styles.authSwitch}>
                  <Text style={styles.authSwitchText}>
                    {authMode === 'login' ? 'New to Buba? ' : 'Already have an account? '}
                    <Text style={styles.authSwitchStrong}>{authMode === 'login' ? 'Create account' : 'Log in'}</Text>
                  </Text>
                </Pressable>
                <Text style={styles.authFootnote}>Your password is sent directly to Supabase Auth and is never stored by Buba.</Text>
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      <Modal animationType="slide" onRequestClose={() => setSellerVisible(false)} visible={sellerVisible}>
        <KeyboardAvoidingView style={[styles.authScreen, { paddingTop: insets.top + 12 }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.authHeader}>
            <Text style={styles.wordmark}>buba.</Text>
            <Pressable accessibilityLabel="Close seller setup" onPress={() => setSellerVisible(false)} style={styles.closeButton}>
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.authContent}>
            <Text style={styles.authEyebrow}>MADE FOR SMALL SELLERS</Text>
            <Text style={styles.authTitle}>Open your shop.</Text>
            <Text style={styles.authIntro}>Connect Stripe to receive payouts, then share a good thing with the Buba community.</Text>
            {sellerBusy && <ActivityIndicator color="#315C43" style={styles.sellerLoader} />}
            {!sellerStatus?.connected && (
              <>
                <Text style={styles.fieldLabel}>Seller country</Text>
                <View style={styles.countryList}>
                  {COUNTRIES.map(([code, name]) => (
                    <Pressable key={code} onPress={() => setSellerCountry(code)} style={[styles.countryChip, sellerCountry === code && styles.countryChipActive]}>
                      <Text style={[styles.countryText, sellerCountry === code && styles.countryTextActive]}>{name}</Text>
                    </Pressable>
                  ))}
                </View>
                <Pressable disabled={sellerBusy} onPress={() => void connectSeller()} style={[styles.primaryButton, sellerBusy && styles.disabledPrimary]}>
                  <Text style={styles.primaryButtonText}>Connect Stripe payouts</Text>
                </Pressable>
                <Text style={styles.authFootnote}>Stripe securely handles seller identity and payout details.</Text>
              </>
            )}
            {sellerStatus?.connected && (
              <>
                <Text style={styles.connectedMessage}>✓  Stripe payouts are connected and ready.</Text>
                <Field label="Product name" value={listingName} onChangeText={setListingName} placeholder="Handmade ceramic mug" />
                <Field label="Price (EUR)" value={listingPrice} onChangeText={setListingPrice} placeholder="24.00" keyboardType="decimal-pad" />
                <Text style={styles.fieldLabel}>Category</Text>
                <View style={styles.countryList}>
                  {CATEGORIES.slice(1).map(category => (
                    <Pressable key={category} onPress={() => setListingCategory(category)} style={[styles.countryChip, listingCategory === category && styles.countryChipActive]}>
                      <Text style={[styles.countryText, listingCategory === category && styles.countryTextActive]}>{category}</Text>
                    </Pressable>
                  ))}
                </View>
                <Pressable disabled={listingBusy} onPress={() => void publishProduct()} style={[styles.primaryButton, listingBusy && styles.disabledPrimary]}>
                  {listingBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Add to marketplace</Text>}
                </Pressable>
              </>
            )}
            {!!sellerError && <Text accessibilityRole="alert" style={styles.inlineError}>{sellerError}</Text>}
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      <Modal animationType="fade" onRequestClose={() => setAccountVisible(false)} transparent visible={accountVisible}>
        <View style={styles.modalShade}>
          <View style={styles.accountCard}>
            <Text style={styles.authEyebrow}>YOUR BUBA</Text>
            <Text style={styles.accountTitle}>{session ? accountLabel : 'Good finds await.'}</Text>
            {session ? (
              <>
                <Text style={styles.authIntro}>{session.user.email}</Text>
                <Text style={styles.profileStatus}>
                  {session.user.email_confirmed_at ? 'Email verified' : 'Email not verified'}
                </Text>
                {!session.user.email_confirmed_at && (
                  <Pressable onPress={async () => {
                    if (!supabase || !session.user.email) return;
                    const { error: resendError } = await supabase.auth.resend({ type: 'signup', email: session.user.email });
                    Alert.alert(resendError ? 'Unable to resend email' : 'Email sent', resendError?.message ?? 'Check your inbox for a new verification link.');
                  }} style={styles.textButton}>
                    <Text style={styles.textButtonLabel}>Resend verification email</Text>
                  </Pressable>
                )}
                <Pressable onPress={() => void signOut()} style={styles.secondaryButton}>
                  <Text style={styles.secondaryButtonText}>Log out</Text>
                </Pressable>
              </>
            ) : (
              <Pressable onPress={() => { setAccountVisible(false); openAuth(); }} style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>Log in or create an account</Text>
              </Pressable>
            )}
            <Pressable onPress={() => setAccountVisible(false)} style={styles.textButton}>
              <Text style={styles.textButtonLabel}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F7F6F2' },
  content: { paddingHorizontal: 20, paddingBottom: 44 },
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F7F6F2', gap: 12 },
  loadingText: { color: '#777D73', fontSize: 13 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 },
  wordmark: { color: '#20251F', fontFamily: 'Georgia', fontSize: 34, fontWeight: '700', letterSpacing: -2 },
  tagline: { color: '#777D73', fontSize: 8, fontWeight: '700', letterSpacing: 1.7, marginTop: -2 },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  accountButton: { maxWidth: 100, minHeight: 40, justifyContent: 'center', paddingHorizontal: 13, borderRadius: 22, backgroundColor: '#FFFFFF' },
  accountButtonText: { color: '#20251F', fontSize: 12, fontWeight: '600' },
  bagButton: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 13, borderRadius: 22, backgroundColor: '#FFFFFF' },
  bagButtonText: { color: '#20251F', fontSize: 12, fontWeight: '600' },
  bagCount: { minWidth: 21, height: 21, overflow: 'hidden', borderRadius: 11, color: '#FFFFFF', backgroundColor: '#315C43', textAlign: 'center', textAlignVertical: 'center', fontSize: 10, fontWeight: '700', lineHeight: 21 },
  hero: { minHeight: 268, overflow: 'hidden', justifyContent: 'center', paddingHorizontal: 25, paddingVertical: 25, borderRadius: 8, backgroundColor: '#3B5944' },
  heroDecoration: { position: 'absolute', top: -100, right: -55, width: 260, height: 260, borderRadius: 130, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)' },
  heroEyebrow: { marginBottom: 12, color: '#E6EBDD', fontSize: 9, fontWeight: '700', letterSpacing: 1.5 },
  heroTitle: { color: '#FFFFFF', fontFamily: 'Georgia', fontSize: 42, letterSpacing: -1.4, lineHeight: 44 },
  heroBody: { maxWidth: 290, marginTop: 12, color: 'rgba(255,255,255,0.8)', fontSize: 12, lineHeight: 18 },
  heroButton: { alignSelf: 'flex-start', marginTop: 18, paddingHorizontal: 15, paddingVertical: 11, borderRadius: 22, backgroundColor: '#FFFFFF' },
  heroButtonText: { color: '#20251F', fontSize: 11, fontWeight: '700' },
  sectionHeading: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, marginTop: 30, marginBottom: 15 },
  sectionTitle: { color: '#20251F', fontFamily: 'Georgia', fontSize: 27, letterSpacing: -0.6 },
  sectionSubtitle: { marginTop: 4, color: '#777D73', fontSize: 10 },
  sellLink: { paddingBottom: 3 },
  sellLinkText: { color: '#315C43', fontSize: 10, fontWeight: '700' },
  searchInput: { height: 43, paddingHorizontal: 16, borderWidth: 1, borderColor: '#E8E7E0', borderRadius: 23, backgroundColor: '#FFFFFF', color: '#20251F', fontSize: 12 },
  categoryList: { gap: 7, paddingVertical: 13 },
  categoryChip: { paddingHorizontal: 14, paddingVertical: 9, borderWidth: 1, borderColor: '#E8E7E0', borderRadius: 20 },
  categoryChipActive: { borderColor: '#315C43', backgroundColor: '#315C43' },
  categoryText: { color: '#5E655C', fontSize: 10, fontWeight: '600' },
  categoryTextActive: { color: '#FFFFFF' },
  productRow: { gap: 12, marginBottom: 20 },
  productCard: { flex: 1, minWidth: 0 },
  productArt: { position: 'relative', aspectRatio: 0.88, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  productEmoji: { fontSize: 61 },
  productTag: { position: 'absolute', top: 10, left: 10, overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.87)', color: '#465145', fontSize: 8, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase' },
  addButton: { position: 'absolute', right: 10, bottom: 10, width: 35, height: 35, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: '#FFFFFF', elevation: 2 },
  addButtonText: { marginTop: -2, color: '#315C43', fontSize: 25, lineHeight: 29 },
  pressed: { opacity: 0.76 },
  productName: { marginTop: 9, color: '#20251F', fontSize: 12, fontWeight: '600', lineHeight: 17 },
  productBottom: { flexDirection: 'row', justifyContent: 'space-between', gap: 6, marginTop: 4 },
  productSeller: { flex: 1, color: '#777D73', fontSize: 9 },
  productPrice: { color: '#20251F', fontSize: 10, fontWeight: '700' },
  emptyState: { alignItems: 'center', paddingVertical: 46, paddingHorizontal: 20 },
  emptyEmoji: { marginBottom: 11, fontSize: 39 },
  emptyTitle: { color: '#20251F', fontFamily: 'Georgia', fontSize: 20, textAlign: 'center' },
  emptyCopy: { maxWidth: 270, marginTop: 7, color: '#777D73', fontSize: 11, lineHeight: 17, textAlign: 'center' },
  errorBanner: { marginTop: 4, padding: 12, borderRadius: 5, backgroundColor: '#F4E6E1', color: '#963D33', fontSize: 11, lineHeight: 16 },
  communityCard: { alignItems: 'center', marginTop: 20, padding: 25, borderRadius: 7, backgroundColor: '#EAE9DF' },
  communityEmoji: { marginBottom: 10, fontSize: 42 },
  communityEyebrow: { marginBottom: 9, color: '#315C43', fontSize: 8, fontWeight: '700', letterSpacing: 1.4 },
  communityTitle: { maxWidth: 280, color: '#20251F', fontFamily: 'Georgia', fontSize: 24, lineHeight: 29, textAlign: 'center' },
  communityButton: { marginTop: 16, paddingHorizontal: 15, paddingVertical: 10, borderRadius: 20, backgroundColor: '#315C43' },
  communityButtonText: { color: '#FFFFFF', fontSize: 10, fontWeight: '700' },
  modalShade: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(23,29,24,0.48)' },
  sheet: { maxHeight: '88%', paddingHorizontal: 21, paddingTop: 11, paddingBottom: 18, borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: '#F7F6F2' },
  sheetHandle: { alignSelf: 'center', width: 36, height: 4, marginBottom: 17, borderRadius: 2, backgroundColor: '#D7D8CF' },
  sheetHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 15, borderBottomWidth: 1, borderBottomColor: '#E8E7E0' },
  sheetTitle: { color: '#20251F', fontFamily: 'Georgia', fontSize: 27 },
  sheetSubtitle: { marginTop: 3, color: '#777D73', fontSize: 10 },
  closeButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: '#EEEDE7' },
  closeText: { marginTop: -2, color: '#20251F', fontSize: 23 },
  sheetItems: { minHeight: 160, maxHeight: 390 },
  emptyBag: { alignItems: 'center', paddingVertical: 38 },
  cartRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#E8E7E0' },
  cartArt: { width: 57, height: 66, alignItems: 'center', justifyContent: 'center', borderRadius: 5 },
  cartEmoji: { fontSize: 28 },
  cartDetails: { flex: 1 },
  cartName: { color: '#20251F', fontSize: 11, fontWeight: '600' },
  cartPrice: { marginTop: 3, color: '#777D73', fontSize: 10 },
  quantityControl: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 8 },
  quantityButton: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#E8E7E0', borderRadius: 12, backgroundColor: '#FFFFFF' },
  quantityButtonText: { marginTop: -2, color: '#20251F', fontSize: 15 },
  quantityText: { color: '#20251F', fontSize: 10 },
  disabledButton: { opacity: 0.45 },
  cartLineTotal: { color: '#20251F', fontSize: 10, fontWeight: '700' },
  cartFooter: { paddingTop: 14, borderTopWidth: 1, borderTopColor: '#E8E7E0' },
  subtotalRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 13 },
  subtotalLabel: { color: '#20251F', fontSize: 12, fontWeight: '600' },
  subtotalValue: { color: '#20251F', fontSize: 13, fontWeight: '700' },
  primaryButton: { minHeight: 47, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, borderRadius: 25, backgroundColor: '#315C43' },
  primaryButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  disabledPrimary: { opacity: 0.5 },
  cartNote: { marginTop: 9, color: '#777D73', fontSize: 9, textAlign: 'center' },
  textButton: { alignSelf: 'center', paddingVertical: 11 },
  textButtonLabel: { color: '#315C43', fontSize: 11, fontWeight: '700' },
  authScreen: { flex: 1, backgroundColor: '#F7F6F2' },
  authHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, paddingBottom: 12 },
  authContent: { paddingHorizontal: 23, paddingBottom: 40 },
  authEyebrow: { marginTop: 17, marginBottom: 10, color: '#315C43', fontSize: 9, fontWeight: '700', letterSpacing: 1.5 },
  authTitle: { color: '#20251F', fontFamily: 'Georgia', fontSize: 33, letterSpacing: -0.7 },
  authIntro: { marginTop: 7, marginBottom: 22, color: '#777D73', fontSize: 12, lineHeight: 18 },
  field: { marginBottom: 14 },
  fieldLabel: { marginBottom: 7, color: '#343A33', fontSize: 10, fontWeight: '700' },
  input: { height: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: '#E8E7E0', borderRadius: 5, backgroundColor: '#FFFFFF', color: '#20251F', fontSize: 12 },
  formRow: { flexDirection: 'row', gap: 10 },
  formHalf: { flex: 1 },
  countryList: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 7, marginBottom: 15 },
  countryChip: { paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: '#E8E7E0', borderRadius: 18, backgroundColor: '#FFFFFF' },
  countryChipActive: { borderColor: '#315C43', backgroundColor: '#315C43' },
  countryText: { color: '#5E655C', fontSize: 9 },
  countryTextActive: { color: '#FFFFFF', fontWeight: '700' },
  inlineError: { marginBottom: 12, color: '#A53E34', fontSize: 11, lineHeight: 16 },
  authSwitch: { alignItems: 'center', paddingVertical: 17 },
  authSwitchText: { color: '#777D73', fontSize: 11 },
  authSwitchStrong: { color: '#315C43', fontWeight: '700' },
  authFootnote: { marginTop: 8, color: '#777D73', fontSize: 9, lineHeight: 15, textAlign: 'center' },
  sellerLoader: { marginVertical: 18 },
  connectedMessage: { marginBottom: 17, padding: 12, borderRadius: 5, backgroundColor: '#E9EEE5', color: '#315C43', fontSize: 11, lineHeight: 16 },
  accountCard: { marginHorizontal: 22, marginBottom: 22, padding: 23, borderRadius: 9, backgroundColor: '#F7F6F2' },
  accountTitle: { color: '#20251F', fontFamily: 'Georgia', fontSize: 26 },
  profileStatus: { marginTop: 4, color: '#315C43', fontSize: 11, fontWeight: '600' },
  secondaryButton: { minHeight: 43, alignItems: 'center', justifyContent: 'center', marginTop: 13, borderWidth: 1, borderColor: '#D7D8CF', borderRadius: 22 },
  secondaryButtonText: { color: '#20251F', fontSize: 11, fontWeight: '600' },
});
