import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  Field,
  HStack,
  Input,
  Stack,
  Text,
} from "@chakra-ui/react";
import { usersApi } from "../api/users";
import { useAuth } from "../context/AuthContext";
import { PageHeader } from "../components/PageHeader";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { notifyError, notifySuccess } from "../components/ui/toaster";

export function AccountPage() {
  const { user, setUser, logout } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState(user?.name ?? "");
  const [savingName, setSavingName] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [deactivating, setDeactivating] = useState(false);

  if (!user) return null;

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    setSavingName(true);
    try {
      setUser(await usersApi.updateMe(name.trim()));
      notifySuccess("Profile updated");
    } catch (err) {
      notifyError("Couldn't update profile", err);
    } finally {
      setSavingName(false);
    }
  };

  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8 || newPassword.length > 128) {
      notifyError(
        "Invalid password",
        new Error("New password must be 8–128 characters"),
      );
      return;
    }
    setSavingPassword(true);
    try {
      await usersApi.changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      notifySuccess("Password changed");
    } catch (err) {
      notifyError("Couldn't change password", err);
    } finally {
      setSavingPassword(false);
    }
  };

  const deactivate = async () => {
    setDeactivating(true);
    try {
      await usersApi.deactivateMe();
      logout();
      navigate("/");
      notifySuccess("Account deactivated");
    } catch (err) {
      notifyError("Couldn't deactivate account", err);
      setDeactivating(false);
      setConfirmDeactivate(false);
    }
  };

  return (
    <>
      <PageHeader title="Your account" />

      <Stack gap="6" maxW="xl">
        <Card.Root>
          <Card.Header>
            <Card.Title>Profile</Card.Title>
            <Card.Description>
              {user.email}{" "}
              <Badge colorPalette={user.role === "admin" ? "purple" : "gray"}>
                {user.role}
              </Badge>
            </Card.Description>
          </Card.Header>
          <Card.Body>
            <form onSubmit={saveName}>
              <Stack gap="4">
                <Field.Root required>
                  <Field.Label>Name</Field.Label>
                  <Input
                    maxLength={100}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field.Root>
                <HStack>
                  <Button
                    type="submit"
                    colorPalette="brand"
                    loading={savingName}
                    disabled={!name.trim() || name.trim() === user.name}
                  >
                    Save
                  </Button>
                </HStack>
              </Stack>
            </form>
          </Card.Body>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Change password</Card.Title>
          </Card.Header>
          <Card.Body>
            <form onSubmit={savePassword}>
              <Stack gap="4">
                <Field.Root required>
                  <Field.Label>Current password</Field.Label>
                  <Input
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                  />
                </Field.Root>
                <Field.Root required>
                  <Field.Label>New password</Field.Label>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                  <Field.HelperText>8–128 characters</Field.HelperText>
                </Field.Root>
                <HStack>
                  <Button
                    type="submit"
                    colorPalette="brand"
                    loading={savingPassword}
                  >
                    Update password
                  </Button>
                </HStack>
              </Stack>
            </form>
          </Card.Body>
        </Card.Root>

        <Card.Root borderColor="red.muted">
          <Card.Header>
            <Card.Title>Deactivate account</Card.Title>
            <Card.Description>
              Your orders are kept, but you won't be able to sign in or place
              new orders.
            </Card.Description>
          </Card.Header>
          <Card.Footer>
            <Button
              variant="outline"
              colorPalette="red"
              onClick={() => setConfirmDeactivate(true)}
            >
              Deactivate my account
            </Button>
          </Card.Footer>
        </Card.Root>

        <Stack gap="0.5">
          <Text fontSize="xs" color="fg.muted">
            Signed in as {user.email} ({user.role})
          </Text>
          <Text fontSize="xs" color="fg.muted">
            User ID: {user.id}
          </Text>
        </Stack>
      </Stack>

      <ConfirmDialog
        open={confirmDeactivate}
        title="Deactivate your account?"
        confirmLabel="Deactivate"
        loading={deactivating}
        onConfirm={deactivate}
        onCancel={() => setConfirmDeactivate(false)}
      >
        You'll be signed out immediately. Only an administrator can reactivate
        the account.
      </ConfirmDialog>
    </>
  );
}
