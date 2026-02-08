import { App, Modal } from "obsidian";

export class ConfirmModal extends Modal {
	message: string;
	onResult: (confirmed: boolean) => void;

	constructor(
		app: App,
		message: string,
		onResult: (confirmed: boolean) => void,
	) {
		super(app);
		this.message = message;
		this.onResult = onResult;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("p", { text: this.message });

		const buttonContainer = contentEl.createDiv({
			cls: "modal-button-container",
		});

		buttonContainer
			.createEl("button", { text: "Cancel" })
			.addEventListener("click", () => {
				this.onResult(false);
				this.close();
			});

		const confirmBtn = buttonContainer.createEl("button", {
			text: "Confirm",
			cls: "mod-warning",
		});
		confirmBtn.addEventListener("click", () => {
			this.onResult(true);
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export function confirm(app: App, message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new ConfirmModal(app, message, resolve);
		modal.open();
	});
}
