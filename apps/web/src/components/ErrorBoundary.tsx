import React, { Component, type ReactNode } from 'react';
import { AlertCircleIcon } from './icons.js';
import { Button } from './ui/button.js';

export interface ErrorBoundaryProps {
  children: ReactNode;
}

export interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('Uncaught error caught by Otis ErrorBoundary:', error, errorInfo);
  }

  handleReload = (): void => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="otis-entry">
          <div className="otis-entry__inner max-w-sm flex flex-col items-center text-center gap-4">
            <div className="size-10 rounded-full bg-destructive/10 flex items-center justify-center text-destructive">
              <AlertCircleIcon />
            </div>
            <div className="flex flex-col gap-1">
              <h1 className="text-xl font-medium text-foreground">Something went wrong</h1>
              <p className="text-sm text-muted-foreground">
                Otis could not load the application. Reloading will refresh your session and conversation state.
              </p>
            </div>
            <Button
              type="button"
              className="otis-button otis-button--primary w-full"
              onClick={this.handleReload}
            >
              Reload Otis
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
