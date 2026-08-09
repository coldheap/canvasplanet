/**
 * Outbound email — currently just the account-verification link
 * (ROADMAP.md §5.1). One `nodemailer` SMTP transport for every environment:
 * Resend's own SMTP relay in production, a local maildev catcher in dev
 * (see env.ts for why SMTP rather than a provider SDK).
 */

import nodemailer from "nodemailer";
import { SITE_NAME } from "@worldcanvas/shared";
import { env } from "../env.js";

const transport = nodemailer.createTransport({
  host: env.smtp.host,
  port: env.smtp.port,
  secure: env.smtp.secure,
  auth: env.smtp.auth,
});

export async function sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
  await transport.sendMail({
    from: env.emailFrom,
    to,
    subject: `Verify your ${SITE_NAME} account`,
    text: `Welcome to ${SITE_NAME}!\n\nVerify your email to finish creating your account:\n${verifyUrl}\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email.`,
    html: `<p>Welcome to ${SITE_NAME}!</p><p><a href="${verifyUrl}">Verify your email</a> to finish creating your account.</p><p>This link expires in 24 hours. If you didn't sign up, ignore this email.</p>`,
  });
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  await transport.sendMail({
    from: env.emailFrom,
    to,
    subject: `Reset your ${SITE_NAME} password`,
    text: `Someone (hopefully you) asked to reset your ${SITE_NAME} password:\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email — your password hasn't changed.`,
    html: `<p>Someone (hopefully you) asked to reset your ${SITE_NAME} password.</p><p><a href="${resetUrl}">Choose a new password</a>.</p><p>This link expires in 1 hour. If you didn't request this, ignore this email — your password hasn't changed.</p>`,
  });
}
