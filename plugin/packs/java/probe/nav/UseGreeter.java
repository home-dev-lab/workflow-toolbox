public final class UseGreeter {
  static String announce(Greeter greeter, String name) {
    return greeter.greet(name);
  }

  static String message = announce(new FriendlyGreeter(), "Ada");
}
