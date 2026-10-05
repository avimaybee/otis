import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { cn } from "cn"

/**
 * Server-driven slash picker (008B). cmdk owns listbox semantics and
 * selection state; visual values come from the popover/menu recipes.
 * The composer textarea drives the controlled value; cmdk never invents
 * choices outside the supplied suggestions.
 */

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      "otis-command-picker flex h-auto w-full flex-col overflow-hidden rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-popover",
      className
    )}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn("overflow-y-auto overflow-x-hidden", className)}
    {...props}
  />
));
CommandList.displayName = CommandPrimitive.List.displayName;

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, id: customId, ...props }, ref) => {
  const innerRef = React.useRef<HTMLDivElement | null>(null);
  React.useImperativeHandle(ref, () => innerRef.current as HTMLDivElement);

  React.useLayoutEffect(() => {
    if (customId && innerRef.current) {
      innerRef.current.id = customId;
    }
  }, [customId]);

  return (
    <CommandPrimitive.Item
      ref={innerRef}
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm select-none transition-colors duration-150 data-[selected='true']:bg-accent data-[disabled='true']:pointer-events-none data-[disabled='true']:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  );
});
CommandItem.displayName = CommandPrimitive.Item.displayName;

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className={cn("py-6 text-center text-sm", className)}
    {...props}
  />
));
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

export { Command, CommandList, CommandItem, CommandEmpty };
