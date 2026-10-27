import { useState, type FormEvent } from "react";
import { Link as RouterLink, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Alert, Button, Card, Field, Input, Link, Stack, Text } from "@chakra-ui/react";
import { useAuth } from "../context/AuthContext";
import { errorMessage } from "../api/http";

function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card.Root maxW="md" mx="auto" mt="8">
      <Card.Header>
        <Card.Title fontSize="2xl">{title}</Card.Title>
      </Card.Header>
      <Card.Body>{children}</Card.Body>
    </Card.Root>
  );
}

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in">
      <form onSubmit={submit}>
        <Stack gap="4">
          {error && (
            <Alert.Root status="error">
              <Alert.Indicator />
              <Alert.Title>{error}</Alert.Title>
            </Alert.Root>
          )}
          <Field.Root required>
            <Field.Label>Email</Field.Label>
            <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field.Root>
          <Field.Root required>
            <Field.Label>Password</Field.Label>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field.Root>
          <Button type="submit" colorPalette="brand" loading={busy}>
            Sign in
          </Button>
          <Text fontSize="sm" color="fg.muted">
            New here?{" "}
            <Link asChild color="brand.fg">
              <RouterLink to="/register" state={location.state}>Create an account</RouterLink>
            </Link>
          </Text>
        </Stack>
      </form>
    </AuthCard>
  );
}

export function RegisterPage() {
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8 || password.length > 128) {
      setError("Password must be 8–128 characters");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await register(name, email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Create your account">
      <form onSubmit={submit}>
        <Stack gap="4">
          {error && (
            <Alert.Root status="error">
              <Alert.Indicator />
              <Alert.Title>{error}</Alert.Title>
            </Alert.Root>
          )}
          <Field.Root required>
            <Field.Label>Name</Field.Label>
            <Input maxLength={100} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field.Root>
          <Field.Root required>
            <Field.Label>Email</Field.Label>
            <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field.Root>
          <Field.Root required>
            <Field.Label>Password</Field.Label>
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <Field.HelperText>8–128 characters</Field.HelperText>
          </Field.Root>
          <Button type="submit" colorPalette="brand" loading={busy}>
            Create account
          </Button>
          <Text fontSize="sm" color="fg.muted">
            Already registered?{" "}
            <Link asChild color="brand.fg">
              <RouterLink to="/login" state={location.state}>Sign in</RouterLink>
            </Link>
          </Text>
        </Stack>
      </form>
    </AuthCard>
  );
}
