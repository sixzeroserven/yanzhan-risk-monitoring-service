import { BadRequestException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import axios from "axios";
import * as crypto from "crypto";
import { EnvConfig } from "../common/config/env.config";

@Injectable()
export class ShoplazzaService implements OnModuleInit {
  private readonly logger = new Logger(ShoplazzaService.name);
  constructor(private readonly env: EnvConfig) {}

  async onModuleInit(): Promise<void> {
    if (!this.env.shoplazza.autoSubscribeWebhook) return;
    try {
      const result = await this.subscribeOrderCreateWebhook();
      this.logger.log(
        `Auto-subscribed Shoplazza webhook: event=orders/create callback=${result.callback_url}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Auto-subscribe Shoplazza webhook failed: ${message}`);
    }
  }

  verifyWebhookSignature(rawBody: Buffer, providedHmac?: string): boolean {
    if (!providedHmac || !rawBody) return false;
    const digest = crypto
      .createHmac("sha256", this.env.shoplazza.webhookSecret)
      .update(rawBody)
      .digest("base64");
    const received = Buffer.from(providedHmac, "utf8");
    const expected = Buffer.from(digest, "utf8");
    if (received.length !== expected.length) return false;
    return crypto.timingSafeEqual(received, expected);
  }

  async cancelOrder(orderId: string | number, reason = "fraud"): Promise<void> {
    await this.client.post(this.path(this.env.shoplazza.cancelOrderPathTemplate, orderId), { reason });
  }

  async appendOrderNote(orderId: string | number, note: string): Promise<void> {
    await this.client.put(this.path(this.env.shoplazza.updateOrderPathTemplate, orderId), {
      order: { id: orderId, note }
    });
  }

  async subscribeOrderCreateWebhook(callbackUrl?: string) {
    const address = (callbackUrl || this.env.shoplazza.webhookCallbackUrl || "").trim();
    if (!address) {
      throw new BadRequestException(
        "callback_url is required. Set SHOPLAZZA_WEBHOOK_CALLBACK_URL or pass callback_url in request body."
      );
    }

    const path = this.env.shoplazza.subscribeWebhookPathTemplate.replace(
      "{version}",
      encodeURIComponent(this.env.shoplazza.apiVersion)
    );
    const payload = {
      event: "orders/create",
      address
    };
    const resp = await this.client.post(path, payload);
    return {
      success: true,
      callback_url: address,
      api_path: path,
      data: resp.data
    };
  }

  private get client() {
    return axios.create({
      baseURL: `https://${this.env.shoplazza.storeDomain}`,
      timeout: this.env.shoplazza.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "X-Shoplazza-Access-Token": this.env.shoplazza.adminToken
      }
    });
  }

  private path(template: string, orderId: string | number): string {
    return template.replace("{orderId}", encodeURIComponent(String(orderId)));
  }
}
