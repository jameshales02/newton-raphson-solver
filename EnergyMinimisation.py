import numpy as np
import matplotlib.pyplot as plt

# -----------------------------
# Problem setup
# -----------------------------
A = np.array([0.0, 0.0])      # left support
B = np.array([1.0, 0.0])      # right support

L = np.linalg.norm(B - A)
N = 9                         # number of links

total_length = 1.20 * L
s = total_length / N          # link length
W = 1.0                       # weight per interior node

# -----------------------------
# Utilities
# -----------------------------
def unpack_coords(v):
    """
    v = [x1,y1, x2,y2, ..., x_{N-1},y_{N-1}]
    returns list [r0, r1, ..., rN]
    """
    r = [A.copy()]
    for k in range(N - 1):
        r.append(np.array([v[2*k], v[2*k + 1]], dtype=float))
    r.append(B.copy())
    return r

def initial_guess():
    """
    Same style as your Newton initial guess.
    """
    x_lin = np.linspace(A[0], B[0], N + 1)
    y_lin = np.linspace(A[1], B[1], N + 1)

    sag = 0.1 * L
    x_int = x_lin[1:-1]
    y_int = y_lin[1:-1] - sag * ((x_int - A[0]) * (B[0] - x_int)) / (0.25 * L * L + 1e-12)

    coords = []
    for k in range(N - 1):
        coords.extend([x_int[k], y_int[k]])

    return np.array(coords, dtype=float)

# -----------------------------
# Objective pieces
# -----------------------------
def potential_energy(v):
    """
    Gravitational potential energy:
    E = sum_j W * y_j over interior nodes
    """
    r = unpack_coords(v)
    E = 0.0
    for j in range(1, N):
        E += W * r[j][1]
    return E

def length_penalty(v):
    """
    Sum of squared link-length errors.
    """
    r = unpack_coords(v)
    pen = 0.0
    for k in range(N):
        lk = np.linalg.norm(r[k+1] - r[k])
        pen += (lk - s)**2
    return pen

def objective(v, lam):
    """
    Penalised objective:
    J(v) = potential_energy + lam * length_penalty
    """
    return potential_energy(v) + lam * length_penalty(v)

def max_length_error(v):
    r = unpack_coords(v)
    errs = []
    for k in range(N):
        lk = np.linalg.norm(r[k+1] - r[k])
        errs.append(abs(lk - s))
    return max(errs)

# -----------------------------
# Numerical gradient
# -----------------------------
def numerical_gradient(f, x, eps=1e-8):
    """
    Central-difference gradient.
    """
    g = np.zeros_like(x)
    for i in range(len(x)):
        xp = x.copy()
        xm = x.copy()
        xp[i] += eps
        xm[i] -= eps
        g[i] = (f(xp) - f(xm)) / (2.0 * eps)
    return g

# -----------------------------
# Backtracking gradient descent
# -----------------------------
def gradient_descent_penalty(
    x0,
    lam,
    max_iter=20000,
    grad_tol=1e-10,
    obj_tol=1e-14,
    alpha0=1.0,
    c=1e-4,
    rho=0.5,
    verbose=False
):
    """
    Minimise J(x) = potential + lam * penalty
    using gradient descent with Armijo backtracking.
    """
    x = x0.copy()
    f = lambda z: objective(z, lam)

    J_old = f(x)

    for it in range(max_iter):
        g = numerical_gradient(f, x)
        gnorm = np.linalg.norm(g)

        if gnorm < grad_tol:
            if verbose:
                print(f"[lam={lam:.1e}] converged by grad in {it} iterations")
            break

        # descent direction
        p = -g

        # Armijo backtracking
        alpha = alpha0
        while True:
            x_trial = x + alpha * p
            J_trial = f(x_trial)

            if J_trial <= J_old - c * alpha * gnorm**2:
                break

            alpha *= rho

            if alpha < 1e-16:
                if verbose:
                    print(f"[lam={lam:.1e}] line search stalled at iter {it}")
                return x

        x = x_trial

        if abs(J_old - J_trial) < obj_tol:
            if verbose:
                print(f"[lam={lam:.1e}] converged by objective change in {it} iterations")
            break

        J_old = J_trial

    return x

# -----------------------------
# Penalty continuation
# -----------------------------
def solve_chain_gradient_descent(x0):
    """
    Outer continuation on lambda:
    start with mild penalty, then tighten.
    """
    x = x0.copy()

    lambdas = [1e1, 1e2, 1e3, 1e4, 1e5, 1e6]

    for lam in lambdas:
        x = gradient_descent_penalty(
            x,
            lam,
            max_iter=30000,
            grad_tol=1e-9,
            obj_tol=1e-14,
            alpha0=1.0,
            verbose=True
        )

        print(
            f"lambda={lam:>8.1e} | "
            f"E={potential_energy(x): .12f} | "
            f"pen={length_penalty(x): .12e} | "
            f"max link err={max_length_error(x): .12e}"
        )

    return x

# -----------------------------
# Solve
# -----------------------------
x0 = initial_guess()
sol = solve_chain_gradient_descent(x0)

r = unpack_coords(sol)

print("\nNodes:")
for i, ri in enumerate(r):
    print(f"r{i} = {ri}")

# -----------------------------
# Plot
# -----------------------------
X = [ri[0] for ri in r]
Y = [ri[1] for ri in r]

plt.figure()
plt.plot(X, Y, marker='o')
for i, (xi, yi) in enumerate(zip(X, Y)):
    plt.text(xi, yi, f"P{i}", ha='right', va='bottom')
plt.axis('equal')
plt.grid(True)
plt.title(f"Discrete Hanging Chain via Gradient Descent ({N} links)")
plt.xlabel("x")
plt.ylabel("y")
plt.show()