import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useChangePassword } from "@/api/queries";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/lib/auth";

// Mirrors AuthController.ChangePassword so invalid or excessive values never hit the network.
const schema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password").max(1024, "Maximum 1024 characters"),
    newPassword: z.string().min(12, "Must be at least 12 characters").max(1024, "Maximum 1024 characters"),
    confirmPassword: z.string().min(1, "Confirm the new password").max(1024, "Maximum 1024 characters"),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });
type FormValues = z.infer<typeof schema>;

export function PasswordSettings() {
  const change = useChangePassword();
  const { logout } = useAuth();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  async function onSubmit(values: FormValues) {
    try {
      await change.mutateAsync({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      reset({ currentPassword: "", newPassword: "", confirmPassword: "" });
      toast.success("Password changed. Sign in again with the new password.");
      // The server revokes every existing admin JWT after a password change.
      logout();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin password</CardTitle>
        <CardDescription>Change the password for the signed-in admin account (BRIEF §6.4).</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="max-w-sm space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="currentPassword">Current password</Label>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              aria-invalid={!!errors.currentPassword}
              {...register("currentPassword")}
            />
            {errors.currentPassword && (
              <p className="text-xs text-destructive">{errors.currentPassword.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="newPassword">New password</Label>
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.newPassword}
              {...register("newPassword")}
            />
            {errors.newPassword && (
              <p className="text-xs text-destructive">{errors.newPassword.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm new password</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.confirmPassword}
              {...register("confirmPassword")}
            />
            {errors.confirmPassword && (
              <p className="text-xs text-destructive">{errors.confirmPassword.message}</p>
            )}
          </div>
          <Button type="submit" disabled={change.isPending}>
            {change.isPending && <Loader2 className="size-4 animate-spin" />}
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
